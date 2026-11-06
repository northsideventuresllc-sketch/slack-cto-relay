// Test fakes: an in-memory brain, a recording Slack sender, a fixed clock.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BrainError,
  relayEvidence,
  type BrainApi,
  type FirePatch,
  type FirePatchGuard,
  type FireRow,
  type HeartbeatRow,
  type LeaseRow,
  type NewFireRow,
} from '../src/brain.js';
import { Blocklist } from '../src/blocklist.js';
import { Breaker } from '../src/breaker.js';
import { CostEnvelope } from '../src/caps.js';
import { loadRegistry, ctoEntry, type CtoKey, type Registry } from '../src/config.js';
import { RelayCore } from '../src/core.js';
import { Dedup } from '../src/dedup.js';
import { FireBook } from '../src/firebook.js';
import { Journal } from '../src/journal.js';
import { LeaseManager } from '../src/lease.js';
import { Metrics } from '../src/metrics.js';
import { Poster, type SlackSender } from '../src/poster.js';
import { Quarantine } from '../src/quarantine.js';
import { RunLog } from '../src/runlog.js';
import { makeAdapter } from '../src/adapters/handoff.js';
import { silentLogger, createLogger } from '../src/util/log.js';
import type { SlackEvent } from '../src/contracts.js';
import { REPO_ROOT } from '../src/config.js';

/** Registry with test channel ids and agent names filled in (the real file carries placeholders until Phase 3). */
export function testRegistry(): Registry {
  const r = loadRegistry();
  const ids: Record<string, string> = { muse: 'CMUSE0001', claude: 'CCLAUDE01', gemini: 'CGEMINI01', 'axon-hermes': 'CAXON0001' };
  const agents: Record<string, string> = { muse: 'MUSE', claude: 'CLAUDE', gemini: 'Gemini CTO', 'axon-hermes': 'AXON-Hermes CTO' };
  return { ...r, ctos: r.ctos.map((c) => ({ ...c, channelId: ids[c.key] ?? c.channelId, agentName: agents[c.key] ?? c.agentName })) };
}

export class FakeClock {
  constructor(public t = Date.parse('2026-11-06T15:00:00Z')) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeBrain implements BrainApi {
  rows = new Map<string, FireRow>();
  leases = new Map<string, LeaseRow>();
  heartbeats = new Map<string, HeartbeatRow>();
  alerts: Array<{ toAgent: string; subject: string }> = [];
  down = false;
  delayMs = 0; // simulate a slow (answering) brain
  insertOrder: string[] = [];
  constructor(private readonly clock: FakeClock) {}

  private check(): void {
    if (this.down) throw new BrainError('unreachable', null);
  }
  private async slow(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }
  async ping(): Promise<void> {
    this.check();
  }
  async insertFireRow(row: NewFireRow): Promise<FireRow> {
    this.check();
    await this.slow();
    const id = randomUUID();
    const r: FireRow = {
      id,
      created_at: new Date(this.clock.now()).toISOString(),
      from_agent: row.fromAgent,
      from_harness: 'cto-relay',
      to_agent: row.toAgent,
      to_harness: row.toHarness,
      channel: 'slack',
      subject: row.subject,
      body: row.body,
      status: 'queued',
      fired_at: row.firedAt,
      completed_at: null,
      evidence: { relay: row.evidence },
      parent_id: null,
      code: 'cto-relay-fire',
    };
    this.rows.set(id, r);
    this.insertOrder.push(id);
    return { ...r };
  }
  async getFireRow(id: string): Promise<FireRow | null> {
    this.check();
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]> {
    this.check();
    return [...this.rows.values()].filter((r) => r.to_agent === toAgent && statuses.includes(r.status ?? '')).map((r) => structuredClone(r));
  }
  async findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null> {
    this.check();
    return [...this.rows.values()].find((r) => r.to_agent === toAgent && relayEvidence(r)?.idem_key === idemKey) ?? null;
  }
  async patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null> {
    this.check();
    const r = this.rows.get(id);
    if (!r) return null;
    if (guard?.statusIn && !guard.statusIn.includes(r.status ?? '')) return null;
    if (guard?.version !== undefined && relayEvidence(r)?.v !== guard.version) return null;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.completed_at !== undefined) r.completed_at = patch.completed_at;
    if (patch.evidence !== undefined) r.evidence = { relay: patch.evidence };
    return structuredClone(r);
  }
  async countStarts(sinceIso: string, toAgent?: string, untilIso?: string): Promise<number> {
    this.check();
    await this.slow();
    return [...this.rows.values()].filter((r) => (r.fired_at ?? '') >= sinceIso && (!untilIso || (r.fired_at ?? '') < untilIso) && !['refused', 'cancelled'].includes(r.status ?? '') && (!toAgent || r.to_agent === toAgent)).length;
  }
  async insertAlertRow(toAgent: string, _from: string, subject: string): Promise<void> {
    this.check();
    this.alerts.push({ toAgent, subject });
  }
  async getLease(name: string): Promise<LeaseRow | null> {
    this.check();
    await this.slow();
    const l = this.leases.get(name);
    return l ? { ...l } : null;
  }
  async insertLease(row: LeaseRow): Promise<LeaseRow | null> {
    this.check();
    if (this.leases.has(row.name)) return null;
    this.leases.set(row.name, { ...row });
    return { ...row };
  }
  async casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null> {
    this.check();
    const l = this.leases.get(name);
    if (!l || l.epoch !== expectEpoch) return null;
    this.leases.set(name, { ...next });
    return { ...next };
  }
  async renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null> {
    this.check();
    const l = this.leases.get(name);
    if (!l || l.epoch !== epoch) return null;
    l.heartbeat_at = heartbeatAt;
    l.expires_at = expiresAt;
    return { ...l };
  }
  async upsertHeartbeat(agent: string, at: string): Promise<void> {
    this.check();
    this.heartbeats.set(agent, { agent, heartbeat_at: at });
  }
  async getHeartbeat(agent: string): Promise<HeartbeatRow | null> {
    this.check();
    return this.heartbeats.get(agent) ?? null;
  }
}

export class FakeSender implements SlackSender {
  posts: Array<{ channel: string; text: string; ts: string }> = [];
  fail = false;
  private n = 0;
  async postWithTs(channel: string, text: string): Promise<string> {
    if (this.fail) throw Object.assign(new Error('x'), { code: 'slack_webapi_platform_error', data: { error: 'invalid_auth' } });
    const ts = `1762400000.${String(++this.n).padStart(6, '0')}`;
    this.posts.push({ channel, text, ts });
    return ts;
  }
  async permalink(channel: string, ts: string): Promise<string> {
    return `https://example.invalid/archives/${channel}/p${ts.replace('.', '')}`;
  }
  texts(): string[] {
    return this.posts.map((p) => p.text);
  }
}

export interface Harness {
  dir: string;
  clock: FakeClock;
  brain: FakeBrain;
  sender: FakeSender;
  registry: Registry;
  journal: Journal;
  book: FireBook;
  core: RelayCore;
  lease: LeaseManager;
  alerts: string[];
  /** Advance time with the lease heartbeat running (every 30 s), as in the live program. */
  advance(ms: number): Promise<void>;
}

export async function makeHarness(ctoKey: CtoKey = 'muse', opts: { dir?: string; clock?: FakeClock; brain?: FakeBrain } = {}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'cto-relay-test-'));
  const clock = opts.clock ?? new FakeClock();
  const brain = opts.brain ?? new FakeBrain(clock);
  const registry = testRegistry();
  const cto = ctoEntry(registry, ctoKey);
  const sender = new FakeSender();
  const alerts: string[] = [];
  const alert = (code: string): void => void alerts.push(code);
  const lease = new LeaseManager(brain, cto.key, `vm:cto-relay-${cto.key}`, clock.now, silentLogger, alert);
  await lease.acquire();
  const journal = new Journal(join(dir, 'journal.jsonl'), clock.now);
  journal.load();
  const book = new FireBook();
  book.load(journal.all());
  const dedup = new Dedup((id) => {
    const e = book.get(id);
    return e && e.terminal ? e.state : null;
  });
  dedup.loadFromJournal(journal.all());
  const runlog = new RunLog(dir, cto.key, clock.now);
  const blocklist = Blocklist.fromFile(join(REPO_ROOT, 'config', 'blocklist.json'));
  const poster = new Poster(sender, lease, blocklist, registry.ctos, runlog, silentLogger, alert, undefined, async () => undefined);
  const scheduled: Array<() => void> = [];
  const core = new RelayCore({
    cto,
    registry,
    timezone: 'America/New_York',
    clock: clock.now,
    log: process.env.TEST_LOG ? createLogger('test', 'debug') : silentLogger,
    brain,
    adapter: makeAdapter(brain, cto, clock.now),
    journal,
    book,
    dedup,
    breaker: new Breaker(journal, cto.key),
    caps: new CostEnvelope({ ...registry.caps, dailyStartCapTotal: 100, monthlyStartCapTotal: 100 }, cto, journal, 'America/New_York'),
    quarantine: new Quarantine(dir, clock.now),
    runlog,
    poster,
    lease,
    metrics: new Metrics(),
    blocklist,
    alert,
    schedule: (_ms, fn) => void scheduled.push(fn),
    sleep: async () => undefined,
  });
  const advance = async (ms: number): Promise<void> => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(30_000, left);
      clock.advance(step);
      left -= step;
      await lease.tick();
    }
  };
  return { dir, clock, brain, sender, registry, journal, book, core, lease, alerts, advance };
}

let evN = 0;
export function mention(h: Harness, target: CtoKey, text: string, opts: Partial<SlackEvent> = {}): SlackEvent {
  const me = ctoEntry(h.registry, target);
  const author = ctoEntry(h.registry, 'muse');
  return {
    eventId: `Ev${++evN}`,
    channelId: me.channelId,
    authorId: author.botUserId,
    text: `<@${me.botUserId}> ${text}`,
    timestamp: `1762400000.${evN}`,
    ingress: 'app_mention',
    triggerId: null,
    command: null,
    edited: false,
    threadTs: null,
    retryNum: 0,
    ...opts,
  };
}

export function fireIdFromReply(text: string): string | null {
  return /fire id ([0-9a-zp-][0-9a-f-]+)/i.exec(text)?.[1] ?? null;
}
