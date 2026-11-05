// router (D6 layer 2): the start path for ONE CTO's program.
//
// Check order, fixed (D4): allowlist → pattern → event dedup → idempotency key
// → task dedup → circuit breaker → queue. Each check is logged by id only.
// Write order, fixed (D4/D6): brain row → journal write + fsync → short reply.
// If the journal write fails, the brain row is voided first (status `refused`,
// writer: the relay) and only then is the refusal logged.

import { randomUUID } from 'node:crypto';
import type { Blocklist } from './blocklist.js';
import { relayEvidence, type BrainApi, type FireRow, type RelayEvidence } from './brain.js';
import type { Breaker } from './breaker.js';
import { REPLY_BREAKER } from './breaker.js';
import type { CostEnvelope } from './caps.js';
import { allowedAuthors, ctoChannelIds, type CtoEntry, type Registry } from './config.js';
import type { FireStatus, HarnessAdapter, SlackEvent } from './contracts.js';
import type { Dedup } from './dedup.js';
import { eventKey, idempotencyKey } from './dedup.js';
import type { FireBook, FireEntry } from './firebook.js';
import { QUEUE_MAX } from './firebook.js';
import type { Journal, JournalInput } from './journal.js';
import type { LeaseManager } from './lease.js';
import type { Metrics } from './metrics.js';
import { parseAbort, parseStart } from './parser.js';
import type { Poster } from './poster.js';
import { MAX_EVENT_FAILURES, REPLY_START_FAILED_FINAL, REPLY_START_FAILED_FIRST, START_RETRY_DELAY_MS, type Quarantine } from './quarantine.js';
import type { RunLog } from './runlog.js';
import { T } from './templates.js';
import { AlreadyClaimedError } from './adapters/handoff.js';
import { sha256, normalizedTaskHash } from './util/hash.js';
import { errorCode, type Logger } from './util/log.js';
import { HOUR, MIN, formatLocal, iso, nextLocalTime, type Clock } from './util/time.js';
import { POST_BACKOFF_MS } from './util/backoff.js';

export const ADAPTER_ANSWER_TIMEOUT_MS = 5 * MIN; // D6 rule (1)
export const MUSE_LINK_WINDOW_MS = 35 * MIN; // D6 rule (2), Muse
export const MANUAL_CLAIM_LIMIT_MS = 30 * MIN; // D4: claimed within 30 minutes while Muse CTO is online
export const START_EXPIRY_MS = 24 * HOUR; // D4: unclaimed / brain-down starts expire at 24 h
export const BRAIN_RETRY_MS = HOUR; // D4: the brain write is retried hourly
export const HEARTBEAT_OFFLINE_MS = 30 * MIN; // D4: Muse CTO offline when its heartbeat is older than 30 minutes
export const ORPHAN_GRACE_MS = 5 * MIN;
export const CHECKIN_HOUR = 9;

export interface CoreDeps {
  cto: CtoEntry;
  registry: Registry;
  timezone: string;
  clock: Clock;
  log: Logger;
  brain: BrainApi;
  adapter: HarnessAdapter;
  journal: Journal;
  book: FireBook;
  dedup: Dedup;
  breaker: Breaker;
  caps: CostEnvelope;
  quarantine: Quarantine;
  runlog: RunLog;
  poster: Poster;
  lease: LeaseManager;
  metrics: Metrics;
  blocklist: Blocklist;
  alert: (code: string, ids?: Record<string, string | number | null>) => void;
  schedule?: (ms: number, fn: () => void) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface StartContext {
  eventKey: string;
  channelId: string;
  authorId: string;
  messageTs: string | null;
  receivedAt: number;
  idemAt: number; // the time the idempotency key is bucketed on — retries reuse the original
  isRetry: boolean;
  /** Set once the adapter has been reached: adapter starts are never retried (D6). */
  reachedAdapter: boolean;
}

export type StartOutcome =
  | 'ignored'
  | 'replied'
  | 'duplicate'
  | 'breaker'
  | 'already-running'
  | 'queue-full'
  | 'cap'
  | 'stale-epoch'
  | 'started'
  | 'held-brain-down'
  | 'refused-journal';

export class RelayCore {
  readonly allowed: Set<string>;
  readonly channels: Set<string>;
  private readonly agentByBotId: Map<string, string>;

  constructor(readonly d: CoreDeps) {
    this.allowed = allowedAuthors(d.registry);
    this.channels = ctoChannelIds(d.registry);
    this.agentByBotId = new Map(d.registry.ctos.map((c) => [c.botUserId, c.agentName]));
  }

  private now(): number {
    return this.d.clock();
  }

  /** Append a journal record and apply it to the queue in one step. */
  record(input: JournalInput): void {
    const rec = this.d.journal.append({ cto: this.d.cto.key, ...input });
    this.d.book.apply(rec);
  }

  private stateRecord(fireId: string, state: JournalInput['state'], extra: Partial<JournalInput> = {}): void {
    this.record({ kind: 'fire-state', fireId, hash: '', state, ...extra });
  }

  // -------------------------------------------------------------------------
  // Ingress
  // -------------------------------------------------------------------------

  /**
   * One event, validated and try/caught on its own (D6). A failing event is
   * retried in-process with the 1/2/4/8 s backoff up to 5 attempts; then it is
   * quarantined — except start-pattern events, which are exempt (see quarantine.ts).
   */
  async handleEvent(ev: SlackEvent, receivedAtSocket?: number): Promise<void> {
    // Ack latency is measured from socket receipt, so time spent waiting in the lane counts.
    const receivedAt = receivedAtSocket ?? this.now();
    const evKey = eventKey(ev, receivedAt);
    const isStartIngress = ev.ingress === 'app_mention' || ev.ingress === 'slash_command';
    for (let attempt = 1; attempt <= MAX_EVENT_FAILURES; attempt++) {
      const ctx: StartContext = { eventKey: evKey, channelId: ev.channelId, authorId: ev.authorId, messageTs: ev.timestamp || null, receivedAt, idemAt: receivedAt, isRetry: false, reachedAdapter: false };
      try {
        if (isStartIngress) await this.handleStartIngress(ev, ctx);
        else await this.handleMessage(ev);
        this.d.quarantine.clear(evKey);
        return;
      } catch (err) {
        const n = this.d.quarantine.fail(evKey);
        this.d.log.error('event failed', { eventId: ev.eventId || null, eventKey: evKey, attempt: n, err: errorCode(err) });
        this.d.dedup.forget(evKey);
        if (isStartIngress && ctx.reachedAdapter) {
          // Adapter starts are never retried: straight to the start-failure path.
          await this.startFailed(ev, evKey, true, receivedAt);
          return;
        }
        if (attempt < MAX_EVENT_FAILURES) await this.sleep(POST_BACKOFF_MS[Math.min(attempt - 1, POST_BACKOFF_MS.length - 1)] ?? 8000);
      }
    }
    if (isStartIngress) await this.startFailed(ev, evKey, true, receivedAt);
    else this.d.quarantine.quarantine(ev.eventId || evKey, sha256(ev.text), 'failed-5-times');
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Start-pattern events: never quarantined; failure reply + alert, one retry after 1 hour, capped at one. */
  private async startFailed(ev: SlackEvent, evKey: string, first: boolean, idemAt: number = this.now()): Promise<void> {
    this.d.alert(first ? 'start-event-failed' : 'start-event-failed-final', { eventKey: evKey });
    if (first && this.d.quarantine.claimStartRetry(evKey)) {
      await this.d.poster.post(ev.channelId, REPLY_START_FAILED_FIRST, 'template');
      const run = (): void => {
        void (async () => {
          const ctx: StartContext = { eventKey: evKey, channelId: ev.channelId, authorId: ev.authorId, messageTs: ev.timestamp || null, receivedAt: this.now(), idemAt, isRetry: true, reachedAdapter: false };
          try {
            await this.handleStartIngress(ev, ctx);
          } catch {
            await this.startFailed(ev, evKey, false, idemAt);
          }
        })();
      };
      (this.d.schedule ?? ((ms, fn) => setTimeout(fn, ms).unref()))(START_RETRY_DELAY_MS, run);
      return;
    }
    await this.d.poster.post(ev.channelId, REPLY_START_FAILED_FINAL, 'template');
  }

  /** Allowlist (authors + the five CTO channels), then the pattern; anything else is ignored and logged. */
  async handleStartIngress(ev: SlackEvent, ctx: StartContext): Promise<StartOutcome> {
    if (!this.channels.has(ev.channelId)) {
      this.d.runlog.check(ctx.eventKey, 'allowlist', 'outside-cto-channels');
      return 'ignored';
    }
    if (!this.allowed.has(ev.authorId)) {
      this.d.runlog.check(ctx.eventKey, 'allowlist', 'author-not-allowed');
      return 'ignored';
    }
    this.d.runlog.check(ctx.eventKey, 'allowlist', 'ok');
    const parsed = parseStart(ev, this.d.cto, this.d.registry);
    if (parsed.kind === 'ignore') {
      this.d.runlog.check(ctx.eventKey, 'pattern', parsed.reason);
      return 'ignored';
    }
    if (parsed.kind === 'reply') {
      this.d.runlog.check(ctx.eventKey, 'pattern', parsed.reason);
      await this.replyTimed(ev.channelId, parsed.text, ctx.receivedAt, null);
      return 'replied';
    }
    this.d.runlog.check(ctx.eventKey, 'pattern', 'ok');
    return this.handleStart(parsed.task, ctx);
  }

  /** `message` events: never parsed for starts (single-parser rule). They carry aborts. */
  async handleMessage(ev: SlackEvent): Promise<void> {
    if (ev.edited) return;
    const quoted = parseAbort(ev.text);
    if (!quoted) return;
    if (!this.channels.has(ev.channelId) || !this.allowed.has(ev.authorId)) return;
    const e = this.d.book.resolveQuoted(quoted);
    if (!e || e.terminal) return; // not ours (another CTO's program owns that fire id) or already over
    await this.abort(e);
  }

  // -------------------------------------------------------------------------
  // The start path
  // -------------------------------------------------------------------------

  async handleStart(task: string, ctx: StartContext): Promise<StartOutcome> {
    const now = this.now();
    const normHash = normalizedTaskHash(task);
    const idemKey = idempotencyKey(this.d.cto.key, task, ctx.idemAt);

    // event dedup → idempotency key → task dedup
    const verdict = ctx.isRetry ? this.d.dedup.checkRetry(idemKey, normHash, now) : this.d.dedup.check(ctx.eventKey, idemKey, normHash, now);
    this.d.runlog.check(ctx.eventKey, 'dedup', verdict);
    if (verdict !== 'ok') return 'duplicate'; // dropped and logged

    // circuit breaker
    const b = this.d.breaker.check(normHash, now);
    this.d.runlog.check(ctx.eventKey, 'breaker', b.kind);
    if (b.kind === 'tripped') {
      if (b.replyOnce) await this.replyTimed(ctx.channelId, REPLY_BREAKER, ctx.receivedAt, null);
      return 'breaker';
    }

    // queue: already-running, max 10, cost caps
    const holder = this.d.book.lockHolder(now);
    if (holder) {
      this.d.runlog.check(ctx.eventKey, 'queue', 'already-running');
      await this.replyTimed(ctx.channelId, T.alreadyRunning(), ctx.receivedAt, null);
      return 'already-running';
    }
    if (this.d.book.depth() >= QUEUE_MAX) {
      this.d.runlog.check(ctx.eventKey, 'queue', 'full');
      await this.replyTimed(ctx.channelId, T.queueFull(), ctx.receivedAt, null);
      return 'queue-full';
    }
    let brainUp = true;
    try {
      const cap = await this.d.caps.check(this.d.brain, now);
      if (cap.kind === 'refused') {
        this.d.runlog.check(ctx.eventKey, 'queue', `cap-${cap.cap}`);
        await this.replyTimed(ctx.channelId, cap.reply, ctx.receivedAt, null);
        return 'cap';
      }
    } catch {
      brainUp = false; // counts unavailable; re-checked before the deferred brain write
    }
    this.d.runlog.check(ctx.eventKey, 'queue', 'ok');

    const taskHash = sha256(task);
    if (brainUp) {
      // Fence: a live lease read — a stale-epoch fire is refused and logged.
      let fenced: boolean;
      try {
        fenced = await this.d.lease.verifyLive();
      } catch {
        fenced = this.d.lease.canAct();
        brainUp = false;
      }
      if (!fenced) {
        this.d.runlog.check(ctx.eventKey, 'lease', 'stale-epoch');
        return 'stale-epoch';
      }
    }
    if (brainUp) {
      const out = await this.fireToBrain(task, taskHash, normHash, idemKey, ctx);
      if (out !== 'brain-down') return out;
    }
    return this.holdBrainDown(task, taskHash, normHash, idemKey, ctx);
  }

  /** brain row → journal + fsync → short reply. */
  private async fireToBrain(task: string, taskHash: string, normHash: string, idemKey: string, ctx: StartContext): Promise<StartOutcome | 'brain-down'> {
    ctx.reachedAdapter = true;
    let runId: string;
    let status: FireStatus;
    try {
      const res = await withTimeout(
        this.d.adapter.fire({
          task,
          epoch: this.d.lease.currentEpoch(),
          meta: { taskHash, normHash, idemKey, fromAgent: this.agentByBotId.get(ctx.authorId) ?? 'CTO-RELAY', channelId: ctx.channelId, messageTs: ctx.messageTs, permalink: null },
        }),
        ADAPTER_ANSWER_TIMEOUT_MS,
      );
      runId = res.runId;
      status = res.status;
    } catch (err) {
      if (err instanceof AdapterTimeout) {
        await this.d.poster.post(ctx.channelId, T.adapterTimeout('pending'), 'template');
        this.d.alert('adapter-answer-timeout', {});
        return 'refused-journal';
      }
      this.d.log.warn('brain write failed; holding the start in memory', { err: errorCode(err) });
      return 'brain-down';
    }
    this.d.metrics.fire.add(this.now() - ctx.receivedAt);

    try {
      this.record({ kind: 'fire-request', fireId: runId, hash: taskHash, normHash, idemKey, eventKey: ctx.eventKey, channelId: ctx.channelId });
    } catch (err) {
      // Void the brain row FIRST, then log the refusal. A refused start never runs.
      try {
        await this.d.brain.patchFireRow(runId, { status: 'refused', completed_at: iso(this.now()) }, { statusIn: ['queued'] });
      } catch {
        // Void-failure rule: the row stays `queued`; the drain re-checks journal presence and the reconciler marks it failed.
        this.d.alert('void-failed', { fireId: runId });
      }
      this.d.log.error('journal write failed; start refused', { fireId: runId, err: errorCode(err) });
      this.d.runlog.check(runId, 'journal', 'refused');
      await this.replyTimed(ctx.channelId, T.notRecorded(), ctx.receivedAt, null);
      return 'refused-journal';
    }
    this.d.dedup.accept(idemKey, normHash, runId, this.now());
    this.d.breaker.record(normHash, runId, this.now());
    this.d.runlog.started(runId, taskHash, this.d.cto.key);

    const safe = this.d.poster.safeTask(task);
    const reply = status === 'started-automatically' ? T.startedAutomatically(safe, runId) : T.queuedForPerson(safe, runId, this.d.cto);
    const posted = await this.replyTimed(ctx.channelId, reply, ctx.receivedAt, runId);
    if (posted) this.stateRecord(runId, 'reply-posted');
    return 'started';
  }

  /** Brain down: hold the text in memory, journal only its hash, reply, retry hourly, expire at 24 h. */
  private async holdBrainDown(task: string, taskHash: string, normHash: string, idemKey: string, ctx: StartContext): Promise<StartOutcome> {
    const provisionalId = `p-${randomUUID()}`;
    try {
      this.record({ kind: 'fire-request', fireId: provisionalId, hash: taskHash, normHash, idemKey, eventKey: ctx.eventKey, channelId: ctx.channelId, provisional: true });
    } catch (err) {
      this.d.log.error('journal write failed while brain down; start refused', { err: errorCode(err) });
      await this.replyTimed(ctx.channelId, T.notRecorded(), ctx.receivedAt, null);
      return 'refused-journal';
    }
    const e = this.d.book.get(provisionalId);
    if (e) {
      e.heldTask = task;
      e.nextBrainRetryAt = this.now() + BRAIN_RETRY_MS;
    }
    this.d.dedup.accept(idemKey, normHash, provisionalId, this.now());
    this.d.breaker.record(normHash, provisionalId, this.now());
    const safe = this.d.poster.safeTask(task);
    // Manual CTOs: with the brain down the heartbeat cannot be read, so Muse CTO is treated as offline (fail-safe).
    const reply = this.d.cto.adapter === 'automatic-muse' ? T.brainDown(safe, provisionalId) : T.waitingBothDown(safe, provisionalId);
    const posted = await this.replyTimed(ctx.channelId, reply, ctx.receivedAt, provisionalId);
    if (posted) this.stateRecord(provisionalId, 'reply-posted');
    this.d.alert('brain-down-start-held', { fireId: provisionalId });
    return 'held-brain-down';
  }

  /** Hourly retry of a held brain-down start; expiry at 24 h. */
  async retryHeld(e: FireEntry): Promise<void> {
    const now = this.now();
    if (!e.provisional || e.terminal) return;
    if (now - e.acceptedAt >= START_EXPIRY_MS) {
      e.heldTask = null;
      this.stateRecord(e.id, 'expired', { reason: 'brain-down-too-long' });
      this.d.runlog.write({ kind: 'expiry', fireId: e.id, writer: 'relay', reason: 'brain-down-too-long' });
      await this.d.poster.post(e.channelId, T.brainDownTooLong(), 'template', e.id);
      return;
    }
    if (!e.heldTask || (e.nextBrainRetryAt !== null && now < e.nextBrainRetryAt)) return;
    e.nextBrainRetryAt = now + BRAIN_RETRY_MS;
    const task = e.heldTask;
    try {
      const cap = await this.d.caps.check(this.d.brain, now);
      if (cap.kind === 'refused') {
        e.heldTask = null;
        this.stateRecord(e.id, 'refused', { reason: `cap-${cap.cap}` });
        await this.d.poster.post(e.channelId, cap.reply, 'template', e.id);
        return;
      }
      if (!(await this.d.lease.verifyLive())) return;
      // A write that timed out may have landed: adopt it instead of writing twice.
      const existing = await this.d.brain.findFireRowByIdem(this.d.cto.agentName, e.idemKey);
      const runId =
        existing?.id ??
        (
          await this.d.adapter.fire({
            task,
            epoch: this.d.lease.currentEpoch(),
            meta: { taskHash: e.taskHash, normHash: e.normHash, idemKey: e.idemKey, fromAgent: 'CTO-RELAY', channelId: e.channelId, messageTs: null, permalink: null },
          })
        ).runId;
      const provisionalId = e.id;
      this.stateRecord(provisionalId, 'brain-written', { brainId: runId });
      this.d.runlog.started(runId, e.taskHash, this.d.cto.key);
      const safe = this.d.poster.safeTask(task);
      const reply = this.d.cto.adapter === 'automatic-muse' ? T.startedAutomatically(safe, runId) : T.queuedForPerson(safe, runId, this.d.cto);
      await this.d.poster.post(e.channelId, reply, 'template', runId);
    } catch {
      // still down — next try in an hour
    }
  }

  /** Short reply, timed for the <3 s bound (ack latency, P50/P95/max, breach count). */
  private async replyTimed(channelId: string, text: string, receivedAt: number, fireId: string | null): Promise<boolean> {
    const r = await this.d.poster.post(channelId, text, 'template', fireId);
    if (r.ok) this.d.metrics.recordAck(this.now() - receivedAt);
    else this.d.alert('short-reply-failed', { fireId });
    return r.ok;
  }

  // -------------------------------------------------------------------------
  // Abort (D4): valid until the run starts. Abort-vs-claim: journal write time vs journal write time.
  // -------------------------------------------------------------------------

  async abort(e: FireEntry): Promise<void> {
    this.stateRecord(e.id, 'abort-requested');
    const abortAt = e.abortAt ?? this.now();
    if (e.claimAt !== null && e.claimAt < abortAt) {
      await this.stopRequest(e, 'claim-first');
      return;
    }
    if (e.provisional) {
      e.heldTask = null;
      this.stateRecord(e.id, 'cancelled', { reason: 'abort' });
      await this.d.poster.post(e.channelId, T.aborted(e.id), 'template', e.id);
      return;
    }
    try {
      await this.d.adapter.cancel(e.id);
    } catch (err) {
      if (err instanceof AlreadyClaimedError) {
        // The brain shows a claim the journal has not seen yet: the run cannot be un-claimed, so it becomes a stop request.
        await this.stopRequest(e, 'brain-claimed');
        return;
      }
      throw err;
    }
    this.stateRecord(e.id, 'cancelled', { reason: 'abort' });
    this.d.runlog.write({ kind: 'state', fireId: e.id, state: 'cancelled', writer: 'relay' });
    await this.d.poster.post(e.channelId, T.aborted(e.id), 'template', e.id);
  }

  private async stopRequest(e: FireEntry, reason: string): Promise<void> {
    this.stateRecord(e.id, 'stop-requested', { reason });
    this.d.alert('stop-requested', { fireId: e.id });
    await this.d.poster.post(e.channelId, T.stopRequested(e.id), 'template', e.id);
  }

  // -------------------------------------------------------------------------
  // Manual state machine transitions (driven by Muse CTO through the control socket, or by the drain via the brain row)
  // -------------------------------------------------------------------------

  /** Read-modify-write of the relay's evidence block, guarded by its version. */
  async updateEvidence(id: string, mutate: (ev: RelayEvidence) => RelayEvidence, status?: { to: NonNullable<Parameters<BrainApi['patchFireRow']>[1]['status']>; from: string[]; completed?: boolean }): Promise<FireRow | null> {
    for (let i = 0; i < 3; i++) {
      const row = await this.d.brain.getFireRow(id);
      if (!row) return null;
      const ev = relayEvidence(row);
      if (!ev) return null;
      const next = { ...mutate({ ...ev }), v: ev.v + 1 };
      const patched = await this.d.brain.patchFireRow(
        id,
        { evidence: next, ...(status ? { status: status.to } : {}), ...(status?.completed ? { completed_at: iso(this.now()) } : {}) },
        { version: ev.v, ...(status ? { statusIn: status.from } : {}) },
      );
      if (patched) return patched;
      if (status) {
        const cur = await this.d.brain.getFireRow(id);
        if (cur && !status.from.includes(cur.status ?? '')) return null;
      }
    }
    return null;
  }

  /** Muse CTO's pre-start check + claim (D4): no duplicate run for the same task; claim recorded in the journal BEFORE work starts. */
  async claim(fireId: string, name: string): Promise<{ ok: boolean; reason: string }> {
    const e = this.d.book.resolveQuoted(fireId);
    if (!e || e.terminal) return { ok: false, reason: 'unknown-or-closed' };
    if (e.provisional) return { ok: false, reason: 'brain-write-pending' };
    if (e.abortAt !== null) return { ok: false, reason: 'abort-won' };
    if (e.claimAt !== null) return { ok: false, reason: 'already-claimed' };
    const dup = this.d.book.inFlight().find((o) => o.id !== e.id && o.normHash === e.normHash && o.claimAt !== null);
    if (dup) return { ok: false, reason: 'duplicate-run' };
    this.stateRecord(e.id, 'claimed', { claimName: name.slice(0, 80) });
    const now = iso(this.now());
    const row = await this.updateEvidence(e.id, (ev) => ({ ...ev, claim: { name: name.slice(0, 80), at: now }, last_progress_at: now }), { to: 'claimed', from: ['queued'] });
    if (!row) this.d.alert('claim-brain-write-failed', { fireId: e.id });
    this.d.runlog.progress(e.id, 'claimed', this.d.cto.key);
    if (e.claimAt !== null) this.d.metrics.manualQueue.add(e.claimAt - e.acceptedAt);
    return { ok: true, reason: 'claimed' };
  }

  async markStarted(fireId: string): Promise<{ ok: boolean; reason: string }> {
    const e = this.d.book.resolveQuoted(fireId);
    if (!e || e.terminal) return { ok: false, reason: 'unknown-or-closed' };
    if (e.claimAt === null) return { ok: false, reason: 'not-claimed' };
    this.stateRecord(e.id, 'started');
    const now = iso(this.now());
    await this.updateEvidence(e.id, (ev) => ({ ...ev, last_progress_at: now }), { to: 'started', from: ['claimed'] });
    this.d.runlog.progress(e.id, 'started', this.d.cto.key);
    return { ok: true, reason: 'started' };
  }

  /** Post the run link (second message) and write `linked`. */
  async postLink(e: FireEntry, link: string): Promise<boolean> {
    if (e.linkPosted || e.terminal) return false;
    const clean = link.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (this.d.blocklist.check(clean).length > 0) {
      this.d.alert('run-link-blocked', { fireId: e.id });
      return false;
    }
    const r = await this.d.poster.post(e.channelId, T.runLink(clean), 'template', e.id);
    if (!r.ok) return false;
    this.stateRecord(e.id, 'link-posted');
    this.stateRecord(e.id, 'linked');
    const now = iso(this.now());
    await this.updateEvidence(e.id, (ev) => ({ ...ev, run_chat_url: clean, link_posted_at: now, last_progress_at: now }), { to: 'linked', from: ['queued', 'claimed', 'started'] });
    this.d.runlog.progress(e.id, 'linked', this.d.cto.key, clean);
    this.d.metrics.link.add(this.now() - e.acceptedAt);
    return true;
  }

  async setLink(fireId: string, link: string): Promise<{ ok: boolean; reason: string }> {
    const e = this.d.book.resolveQuoted(fireId);
    if (!e || e.terminal) return { ok: false, reason: 'unknown-or-closed' };
    return (await this.postLink(e, link)) ? { ok: true, reason: 'linked' } : { ok: false, reason: 'not-posted' };
  }

  /** Muse CTO stopped a run after a stop request: the relay posts "stopped". */
  async markStopped(fireId: string): Promise<{ ok: boolean; reason: string }> {
    const e = this.d.book.resolveQuoted(fireId);
    if (!e || e.terminal) return { ok: false, reason: 'unknown-or-closed' };
    this.stateRecord(e.id, 'cancelled', { reason: 'stopped' });
    await this.updateEvidence(e.id, (ev) => ev, { to: 'cancelled', from: ['queued', 'claimed', 'started', 'linked'], completed: true });
    await this.d.poster.post(e.channelId, T.stopped(e.id), 'template', e.id);
    return { ok: true, reason: 'stopped' };
  }

  /** Muse CTO's Monday review clears an overrun block. */
  reviewClear(): void {
    this.record({ kind: 'fire-state', fireId: 'review', hash: '', state: 'review-cleared' });
  }

  // -------------------------------------------------------------------------
  // Brain-row sync (5-minute link check, reconciler, restore)
  // -------------------------------------------------------------------------

  /** Bring one in-flight entry up to date with its brain row. */
  async syncFromRow(e: FireEntry, row: FireRow): Promise<void> {
    const ev = relayEvidence(row);
    const status = row.status ?? '';
    if ((status === 'claimed' || status === 'started' || status === 'linked') && e.claimAt === null) {
      this.stateRecord(e.id, 'claimed', { claimName: (ev?.claim?.name ?? 'Muse CTO (drain)').slice(0, 80) });
      this.d.runlog.progress(e.id, 'claimed', this.d.cto.key);
      if (e.claimAt !== null) this.d.metrics.manualQueue.add(e.claimAt - e.acceptedAt);
    }
    if ((status === 'started' || status === 'linked') && e.startedAt === null) {
      this.stateRecord(e.id, 'started');
      this.d.runlog.progress(e.id, 'started', this.d.cto.key);
    }
    if (ev?.run_chat_url && !e.linkPosted) await this.postLink(e, ev.run_chat_url);
    if (ev?.lock_cleared && !e.lockCleared) this.stateRecord(e.id, 'lock-cleared', { reason: 'stalled-9am' });
    const terminalMap: Record<string, JournalInput['state']> = { cancelled: 'cancelled', closed: 'closed', failed: 'failed', expired: 'expired', refused: 'refused' };
    const t = terminalMap[status];
    if (t && !e.terminal) this.stateRecord(e.id, t, { reason: 'brain-row' });
  }

  /** Is Muse CTO online? Heartbeat newer than 30 minutes. Brain down → offline (fail-safe). */
  async museOnline(): Promise<boolean> {
    try {
      const hb = await this.d.brain.getHeartbeat('MUSE');
      return !!hb && this.now() - Date.parse(hb.heartbeat_at) < HEARTBEAT_OFFLINE_MS;
    } catch {
      return false;
    }
  }

  nextCheckinLabel(): string {
    return formatLocal(nextLocalTime(this.now(), CHECKIN_HOUR, 0, this.d.timezone), this.d.timezone);
  }
}

class AdapterTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AdapterTimeout('adapter answer timeout')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
