// One relay program = one CTO. Wires the D6 layers:
//   slack-transport → router → harness-adapters + poster → run-log
// Fail-closed at startup: no brain → no lease → refuse to start.
// R7-FU-23: so after a restart during a brain outage, restore + the reconciler
// wait until the brain returns (systemd retries every 30 s).

import { join } from 'node:path';
import { cpuUsage, memoryUsage } from 'node:process';
import { Alerter } from './alerts.js';
import { makeAdapter } from './adapters/handoff.js';
import { Blocklist } from './blocklist.js';
import { DirectBrain, type BrainApi } from './brain.js';
import { Breaker } from './breaker.js';
import { BrokerServer, BrokeredBrain, brokerSocketPath } from './broker.js';
import { CostEnvelope } from './caps.js';
import { SlackChannel, EXIT_STAY_DOWN } from './channel/slack.js';
import { Closeouts } from './closeout.js';
import { isPlaceholder, placeholdersBlocking, type RelayConfig } from './config.js';
import { ControlServer, controlSocketPath, type ControlCommand } from './control.js';
import { RelayCore, CHECKIN_HOUR } from './core.js';
import { CRED_BRAIN, CRED_SLACK_APP, CRED_SLACK_BOT, readCredential } from './credentials.js';
import { Dedup } from './dedup.js';
import { FireBook } from './firebook.js';
import { HealthServer } from './health.js';
import { Journal } from './journal.js';
import { LeaseHeldElsewhere, LeaseManager } from './lease.js';
import { Maintenance } from './maintenance.js';
import { Metrics } from './metrics.js';
import { MirrorWriter } from './mirror.js';
import { Outbox } from './outbox.js';
import { Poster } from './poster.js';
import { PostQueueWatcher, type PostQueueEntry } from './postqueue.js';
import { Quarantine } from './quarantine.js';
import { RunLog } from './runlog.js';
import { MuseDuties } from './sweep.js';
import { GitVaultReader } from './vault.js';
import { ensureDir } from './util/durable.js';
import { createLogger, errorCode, type Logger } from './util/log.js';
import { HOUR, MIN, nextLocalTime, realClock, type Clock } from './util/time.js';

export const EXIT_RETRY = 1; // systemd Restart=on-failure retries (brain down, lease held elsewhere)

class Fatal extends Error {
  constructor(readonly exitCode: number, readonly reason: string) {
    super(reason);
  }
}

/** A promise-chain mutex: Slack events, control commands and timers run one at a time. */
class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

export class RelayProgram {
  private readonly log: Logger;
  private readonly clock: Clock = realClock;
  private timers: NodeJS.Timeout[] = [];
  private slack: SlackChannel | null = null;
  private health: HealthServer | null = null;
  private control: ControlServer | null = null;
  private broker: BrokerServer | null = null;
  private lease: LeaseManager | null = null;
  private socketUp = false;
  private readonly lane = new Lane();
  private stopping = false;
  private duties: MuseDuties | null = null;

  constructor(private readonly cfg: RelayConfig) {
    this.log = createLogger(`cto-relay-${cfg.cto.key}`, cfg.logLevel);
  }

  async run(): Promise<number> {
    try {
      await this.start();
      return await new Promise<number>((resolve) => {
        const stop = (): void => void this.stop().then(() => resolve(0));
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
        this.onFatal = (code) => void this.stop().then(() => resolve(code));
      });
    } catch (err) {
      if (err instanceof Fatal) {
        this.log.error('refusing to start', { reason: err.reason, exit: err.exitCode });
        return err.exitCode;
      }
      this.log.error('startup failed', { err: errorCode(err) });
      return EXIT_RETRY;
    }
  }

  private onFatal: (code: number) => void = (code) => process.exit(code);

  private async start(): Promise<void> {
    const cfg = this.cfg;
    const cto = cfg.cto;
    const isMuse = cto.key === 'muse';

    const blocked = placeholdersBlocking(cfg.registry, cto.key);
    if (blocked.length) throw new Fatal(EXIT_STAY_DOWN, `config placeholders unset: ${blocked.join(',')}`);

    ensureDir(cfg.stateDir, 0o700);
    const appToken = readCredential(cfg.credentialsDir, CRED_SLACK_APP);
    const botToken = readCredential(cfg.credentialsDir, CRED_SLACK_BOT);

    const alerter = new Alerter(cfg.stateDir, cto.key, cto.agentName, this.clock, this.log);
    const alert = (code: string, ids?: Record<string, string | number | null>): void => alerter.alert(code, ids);

    // Brain: Muse holds the key (D7); the other three go through the Muse program's broker.
    let brain: BrainApi;
    if (isMuse) {
      if (!cfg.supabaseUrl) throw new Fatal(EXIT_STAY_DOWN, 'SUPABASE_URL not set');
      brain = new DirectBrain({ supabaseUrl: cfg.supabaseUrl, apiKey: readCredential(cfg.credentialsDir, CRED_BRAIN), httpsProxy: cfg.httpsProxy, timeoutMs: 1500 });
    } else {
      brain = new BrokeredBrain(brokerSocketPath(cfg.runDir, cto.key));
    }
    try {
      await brain.ping();
    } catch {
      throw new Fatal(EXIT_RETRY, 'brain unreachable at startup (fail-closed)');
    }
    alerter.attachBrain(brain);

    if (isMuse) {
      this.broker = new BrokerServer(brain, cfg.runDir, this.log);
      this.broker.start(cfg.registry.ctos.filter((c) => c.adapter === 'manual' && !isPlaceholder(c.agentName)));
    }

    const lease = new LeaseManager(brain, cto.key, `${cfg.holder}:cto-relay-${cto.key}`, this.clock, this.log, (code) => alert(code));
    this.lease = lease;
    try {
      await lease.acquire();
    } catch (err) {
      if (err instanceof LeaseHeldElsewhere) throw new Fatal(EXIT_RETRY, 'lease held by another live holder');
      throw new Fatal(EXIT_RETRY, 'lease acquisition failed (fail-closed)');
    }
    lease.startHeartbeat();

    const journal = new Journal(join(cfg.stateDir, 'journal.jsonl'), this.clock);
    journal.load();
    if (journal.badLinesOnLoad) alert('journal-bad-lines-skipped', { count: journal.badLinesOnLoad });
    const book = new FireBook();
    book.load(journal.all());
    const dedup = new Dedup((id) => {
      const e = book.get(id);
      return e && e.terminal ? e.state : null;
    });
    dedup.loadFromJournal(journal.all());
    const runlog = new RunLog(cfg.stateDir, cto.key, this.clock);
    const blocklist = Blocklist.fromFile(cfg.blocklistPath);
    const metrics = new Metrics();

    const slack = new SlackChannel({
      appToken,
      botToken,
      httpsProxy: cfg.httpsProxy,
      log: this.log,
      onFatal: (code) => {
        alert(code);
        this.onFatal(EXIT_STAY_DOWN);
      },
    });
    this.slack = slack;
    try {
      const me = await slack.authTest();
      if (me.userId !== cto.botUserId) throw new Fatal(EXIT_STAY_DOWN, 'bot token belongs to a different bot user');
    } catch (err) {
      if (err instanceof Fatal) throw err;
      alert('token-revoked-or-invalid');
      throw new Fatal(EXIT_STAY_DOWN, 'Slack bot token rejected (fails closed for this CTO only)');
    }

    const poster = new Poster(slack, lease, blocklist, cfg.registry.ctos, runlog, this.log, alert);
    const adapter = makeAdapter(brain, cto, this.clock);
    const serialize = <T,>(fn: () => Promise<T>): Promise<T> => this.lane.run(fn);
    const core = new RelayCore({
      cto,
      registry: cfg.registry,
      timezone: cfg.timezone,
      clock: this.clock,
      log: this.log,
      brain,
      adapter,
      journal,
      book,
      dedup,
      breaker: new Breaker(journal, cto.key),
      caps: new CostEnvelope(cfg.registry.caps, cto, journal, cfg.timezone),
      quarantine: new Quarantine(cfg.stateDir, this.clock),
      runlog,
      poster,
      lease,
      metrics,
      blocklist,
      alert,
      serialize,
    });
    const maintenance = new Maintenance(core, serialize);
    const outbox = new Outbox(cfg.stateDir);
    const closeouts = new Closeouts(core, outbox, new GitVaultReader(cfg.vaultDir, cfg.vaultWebBase), core.d.caps, serialize);

    this.health = new HealthServer({
      cto: cto.key,
      metrics,
      queueDepth: () => book.depth(),
      lease: () => lease.snapshot(),
      adapterHealth: () => adapter.health(),
      socketConnected: () => this.socketUp,
      startedAt: this.clock(),
    });
    try {
      await this.health.listen(cfg.healthBind, cto.healthPort);
    } catch {
      throw new Fatal(EXIT_RETRY, 'health endpoint bind failed');
    }

    this.control = new ControlServer(controlSocketPath(cfg.runDir, cto.key), (c) => this.lane.run(() => this.command(c, core, closeouts, journal)), this.log);
    this.control.start();

    // Restore (D6 steps 1–5) and the reconciler, before taking new events.
    await this.lane.run(() => maintenance.restore()).catch((err) => this.log.error('restore failed', { err: errorCode(err) }));

    // Muse-only duties.
    let duties: MuseDuties | null = null;
    let mirror: MirrorWriter | null = null;
    if (isMuse) {
      duties = new MuseDuties(brain, cfg.registry, poster, slack, this.clock, this.log, alert, (port) => probeHealth(port));
      this.duties = duties;
      if (cfg.mirrorDir) mirror = new MirrorWriter(cfg.mirrorDir, cfg.registry, blocklist, this.clock, cfg.timezone);
      if (cfg.postQueuePath) {
        const pq = new PostQueueWatcher(cfg.postQueuePath, cfg.stateDir, this.clock, (e) => this.lane.run(() => this.postQueueEntry(e, core, poster)), (r) => alert(`post-queue-${r}`));
        this.every(2000, () => pq.poll().catch((err) => this.log.warn('post-queue poll failed', { err: errorCode(err) })));
      }
    }

    // Socket Mode.
    await slack.start();
    this.socketUp = true;
    void (async () => {
      for await (const ev of slack.listenSlack()) {
        if (this.stopping) break;
        if (mirror && ev.ingress === 'message') {
          try {
            mirror.observe(ev);
          } catch {
            this.log.warn('mirror write failed', { eventId: ev.eventId || null });
          }
        }
        const receivedAt = this.clock();
        void this.lane.run(() => core.handleEvent(ev, receivedAt)).catch((err) => this.log.error('event lane error', { err: errorCode(err) }));
      }
    })();

    // Timers.
    // Periodic jobs take the lane per entry (inside Maintenance/Closeouts), never for a whole job.
    this.every(MIN, () => maintenance.timers());
    this.every(MIN, () => closeouts.drain());
    this.every(5 * MIN, () => maintenance.pollRows());
    this.every(30 * MIN, () => maintenance.reconcile());
    if (duties) {
      const d = duties;
      this.every(MIN, () => d.watchSiblings());
      this.every(MIN, () => d.watchPoller());
      this.every(6 * HOUR, () => d.sweep());
    }
    this.daily(CHECKIN_HOUR, 0, async () => {
      if (duties) {
        await duties.clearStalledLocks();
        await duties.sweep();
      }
      await maintenance.pollRows();
      await this.lane.run(() => maintenance.nineAm());
      if (duties) await duties.dailyOpen();
    });
    this.daily(3, 0, async () => {
      await this.lane.run(async () => {
        const r = journal.compact();
        runlog.prune();
        core.d.quarantine.prune();
        this.log.info('nightly compaction', r);
      });
      if (duties && cfg.archiveDir) {
        const archived = await duties.archiveOldRows(cfg.archiveDir);
        this.log.info('brain rows archived', { archived });
      }
    });
    this.watchdog(alert);
    this.log.info('relay up', { cto: cto.key, epoch: lease.currentEpoch(), holder: cfg.holder });
  }

  private async command(c: ControlCommand, core: RelayCore, closeouts: Closeouts, journal: Journal): Promise<unknown> {
    switch (c.cmd) {
      case 'claim':
        return core.claim(c.fireId, c.name);
      case 'start':
        return core.markStarted(c.fireId);
      case 'link':
        return core.setLink(c.fireId, c.link);
      case 'stopped':
        return core.markStopped(c.fireId);
      case 'closeout': {
        // Validate + queue durably inside the lane; the vault read-back and posting follow outside it.
        const r = await closeouts.request({ fireId: c.fireId, vaultLogPath: c.vaultLogPath, sessionUrl: c.sessionUrl, tokens: c.tokens, minutes: c.minutes });
        const entry = r.entry;
        if (entry) setImmediate(() => void closeouts.attempt(entry).catch((err) => this.log.error('close-out attempt failed', { err: errorCode(err) })));
        return { ok: r.ok, reason: r.ok ? 'queued; the map posts after the vault read-back matches' : r.reason };
      }
      case 'copy-check': {
        // R5-FU-9: nightly off-host copy vs brain rows (Muse program only — it holds the brain key).
        if (!this.duties) return { ok: false, reason: 'muse-only' };
        const target = this.cfg.registry.ctos.find((x) => x.key === c.target);
        if (!target || isPlaceholder(target.agentName)) return { ok: false, reason: 'unknown-target' };
        return { ok: true, ...(await this.duties.copyCheck(target, c.ids)) };
      }
      case 'review-clear':
        core.reviewClear();
        return { ok: true };
      case 'journal-has':
        return { has: journal.hasFireRequest(c.fireId) };
      case 'status':
        return this.health?.snapshot();
      case 'test-fail-next-journal-write':
        if (process.env.CTO_RELAY_ENABLE_TEST_HOOKS !== '1') return { ok: false, reason: 'test hooks disabled' };
        journal.faults.failNextWrite = true;
        return { ok: true };
    }
  }

  /** Muse post-queue entries: Muse CTO's own words, or a start relayed for JB. */
  private async postQueueEntry(e: PostQueueEntry, core: RelayCore, poster: Poster): Promise<void> {
    const reg = this.cfg.registry;
    if (e.kind === 'post') {
      const target = e.channel === 'cto-bots' ? reg.ctoBotsChannelId : reg.ctos.find((c) => c.channelName === e.channel)?.channelId;
      if (!target) return void this.log.warn('post-queue: unknown channel');
      await poster.post(target, e.text, 'cto-words');
      return;
    }
    const target = reg.ctos.find((c) => c.key === e.cto);
    if (!target) return;
    if (core.d.blocklist.check(e.task).length > 0) {
      core.d.alert('post-queue-fire-blocked', {});
      return;
    }
    if (target.key === 'muse') {
      // Muse's own start: this program is Muse's single parser.
      const now = this.clock();
      await core.handleStart(e.task.replace(/\s+/g, ' ').trim(), {
        eventKey: `pq-${now}`,
        channelId: target.channelId,
        authorId: target.botUserId,
        messageTs: null,
        receivedAt: now,
        idemAt: now,
        isRetry: false,
        reachedAdapter: false,
      });
      return;
    }
    // Another CTO: post the explicit start pattern as the Muse CTO bot in that CTO's channel.
    // Only that CTO's program receives the app_mention, so exactly one run starts there.
    const task = e.task.replace(/\s+/g, ' ').trim().replace(/<[@!#][^>]*>/g, '');
    if (!this.lease?.canAct()) return;
    try {
      await this.slack?.postWithTs(target.channelId, `<@${target.botUserId}> fire: ${task}`);
      core.d.runlog.write({ kind: 'post', fireId: null, channelId: target.channelId, result: 'start-relayed', writer: 'relay' });
    } catch (err) {
      core.d.alert('start-relay-post-failed', { cto: target.key });
      this.log.error('start relay failed', { err: errorCode(err) });
    }
  }

  private every(ms: number, fn: () => Promise<unknown> | void): void {
    const t = setInterval(() => {
      if (this.stopping) return;
      Promise.resolve()
        .then(fn)
        .catch((err) => this.log.error('timer job failed', { err: errorCode(err) }));
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  private daily(hour: number, minute: number, fn: () => Promise<void>): void {
    const arm = (): void => {
      const now = this.clock();
      const at = nextLocalTime(now, hour, minute, this.cfg.timezone);
      const t = setTimeout(() => {
        if (this.stopping) return;
        fn()
          .catch((err) => this.log.error('daily job failed', { err: errorCode(err), hour }))
          .finally(arm);
      }, at - now);
      t.unref();
      this.timers.push(t);
    };
    arm();
  }

  /** Over 50% CPU sustained 5 minutes → alert and exit (systemd restarts it). MemoryMax=128M is enforced by systemd. */
  private watchdog(alert: (code: string) => void): void {
    let last = cpuUsage();
    let hot = 0;
    this.every(MIN, () => {
      const now = cpuUsage();
      const usedMs = (now.user - last.user + now.system - last.system) / 1000;
      last = now;
      hot = usedMs / MIN > 0.5 ? hot + 1 : 0;
      if (memoryUsage().rss > 120 * 1024 * 1024) alert('memory-near-limit');
      if (hot >= 5) {
        alert('cpu-over-50pct-5min');
        this.onFatal(EXIT_RETRY);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.lease?.stop();
    this.control?.stop();
    this.broker?.stop();
    this.health?.close();
    await this.slack?.stop();
    this.socketUp = false;
    this.log.info('relay stopped');
  }
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch {
    return false;
  }
}
