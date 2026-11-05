// D5 §6 — the close-out sweep, the daily 9am open, the 9am lock clear, and the
// sibling watch. Owner: the Muse relay program (it holds the brain key and is
// a member of all five CTO channels).

import { relayEvidence, type BrainApi, type FireRow, type RelayEvidence } from './brain.js';
import { isPlaceholder, type CtoEntry, type Registry } from './config.js';
import type { Poster } from './poster.js';
import { T, isRelayTemplate } from './templates.js';
import type { Logger } from './util/log.js';
import { appendLineSync } from './util/durable.js';
import { join } from 'node:path';
import { DAY, HOUR, iso, type Clock } from './util/time.js';

export const STALL_MS = 6 * HOUR;
export const UNCLOSED_MS = 24 * HOUR;
export const BRAIN_ROW_RETENTION_MS = 90 * DAY;
export const POLLER_AGENT = 'MINI-POLLER';
export const POLLER_STALE_MS = 5 * 60_000;

/**
 * The still-active test and the ONE stalled definition (D5 close signal + §6;
 * KAR-6, R7-NEW-2). A run is still active if ANY holds:
 * (a) the adapter's status(runId) reports the run as live — counted ONLY when
 *     the adapter has a real live probe (`liveStatus`). No v1 adapter has one:
 *     Muse and the three manual adapters all read the stored brain row, so
 *     prong (a) does NOT apply in v1, and still-active rests on (b) + (c);
 * (b) the CTO's channel has a message from that CTO in the last 6 hours
 *     (relay templates excluded);
 * (c) the run is under way (brain row `claimed`, `started` or `linked`) AND the
 *     last state-changing run-log entry by the CTO's own adapter is under 6 hours old.
 *
 * Stalled ⟺ NOT still active ⟺ (with no live probe) no activity — no (b)
 * message and no (c) entry — for 6 hours. D5 "fails all three for 6 hours" and
 * §6 "no activity for 6 hours" are the same test here, by construction.
 * Unclosed ⟺ stalled AND the last activity is over 24 hours old.
 */
export interface RunActivity {
  liveState: string | null; // adapter status() result; null = the adapter has no live probe (all v1 adapters)
  channelMsgAt: number | null;
  rowStatus: string;
  lastAdapterEntryAt: number | null;
  now: number;
}

const UNDER_WAY = new Set(['claimed', 'started', 'linked']);
const ENDED = new Set(['closed', 'failed', 'expired', 'cancelled', 'refused']);

export function lastActivityAt(a: RunActivity): number | null {
  const xs = [a.channelMsgAt, UNDER_WAY.has(a.rowStatus) ? a.lastAdapterEntryAt : null].filter((x): x is number => x !== null);
  return xs.length ? Math.max(...xs) : null;
}

export function stillActive(a: RunActivity): boolean {
  const pa = a.liveState !== null && !ENDED.has(a.liveState);
  const pb = a.channelMsgAt !== null && a.now - a.channelMsgAt < STALL_MS;
  const pc = UNDER_WAY.has(a.rowStatus) && a.lastAdapterEntryAt !== null && a.now - a.lastAdapterEntryAt < STALL_MS;
  return pa || pb || pc;
}

export function assessRun(a: RunActivity): { stillActive: boolean; stalled: boolean; unclosed: boolean; lastActivity: number | null } {
  const active = stillActive(a);
  const last = lastActivityAt(a);
  return { stillActive: active, stalled: !active, unclosed: !active && (last === null || a.now - last > UNCLOSED_MS), lastActivity: last };
}

export interface SweepFinding {
  cto: string;
  fireId: string;
  kind: 'stalled' | 'unclosed';
}

export interface HistoryReader {
  history(channel: string, oldestTs: string): Promise<Array<{ user: string | null; text: string; ts: string }>>;
}

export class MuseDuties {
  findings: SweepFinding[] = [];
  private siblingFails = new Map<string, number>();
  private siblingDown = new Set<string>();
  private stallPosted = new Set<string>();
  private pollerDown = false;

  constructor(
    private readonly brain: BrainApi,
    private readonly registry: Registry,
    private readonly poster: Poster,
    private readonly slack: HistoryReader,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly alert: (code: string, ids?: Record<string, string | number | null>) => void,
    private readonly fetchHealth: (port: number) => Promise<boolean>,
  ) {}

  private ctos(): CtoEntry[] {
    return this.registry.ctos.filter((c) => !isPlaceholder(c.agentName));
  }

  private async lastCtoMessageAt(cto: CtoEntry): Promise<number | null> {
    try {
      const oldest = String((this.clock() - DAY) / 1000);
      const msgs = await this.slack.history(cto.channelId, oldest);
      let last: number | null = null;
      for (const m of msgs) {
        if (m.user !== cto.botUserId || isRelayTemplate(m.text)) continue;
        const at = Number(m.ts) * 1000;
        if (Number.isFinite(at) && (last === null || at > last)) last = at;
      }
      return last;
    } catch {
      return null;
    }
  }

  /**
   * Every 6 hours. Flags (1) stalled and (2) unclosed, separately, matching on
   * fire id. Detection timing (R7-NEW-1): a run is flagged by the FIRST sweep
   * after 6 hours of silence — so between 6 and 12 hours after its last
   * activity, not "within 6 hours". The warning is posted to the CTO's channel
   * at once when flagged (once per silence), and listed again in the next 9am message.
   */
  async sweep(opts: { post?: boolean } = {}): Promise<SweepFinding[]> {
    const now = this.clock();
    const out: SweepFinding[] = [];
    for (const cto of this.ctos()) {
      let rows: FireRow[];
      try {
        rows = await this.brain.listFireRows(cto.agentName, ['claimed', 'started', 'linked']);
      } catch {
        this.log.warn('sweep: brain unreachable', { cto: cto.key });
        continue;
      }
      if (rows.length === 0) continue;
      const msgAt = await this.lastCtoMessageAt(cto);
      for (const row of rows) {
        const ev = relayEvidence(row);
        const progress = Date.parse(ev?.last_progress_at ?? row.fired_at ?? '');
        const verdict = assessRun({
          liveState: null, // no v1 adapter has a live probe (KAR-6): prong (a) does not apply
          channelMsgAt: msgAt,
          rowStatus: row.status ?? '',
          lastAdapterEntryAt: Number.isFinite(progress) ? progress : null,
          now,
        });
        if (verdict.stalled) {
          out.push({ cto: cto.key, fireId: row.id, kind: 'stalled' });
          const key = `${row.id}|${verdict.lastActivity ?? 'none'}`;
          if (opts.post !== false && !this.stallPosted.has(key)) {
            this.stallPosted.add(key);
            this.alert('run-stalled', { cto: cto.key, fireId: row.id });
            await this.poster.post(cto.channelId, T.stalled(row.id), 'template', row.id);
          }
        }
        if (verdict.unclosed) out.push({ cto: cto.key, fireId: row.id, kind: 'unclosed' });
      }
    }
    this.findings = out;
    return out;
  }

  /** 9am: clear the already-running lock of runs stalled 6 hours (D4 lock-clear actor: the Muse relay program). */
  async clearStalledLocks(): Promise<void> {
    const now = this.clock();
    for (const cto of this.ctos()) {
      const rows = await this.brain.listFireRows(cto.agentName, ['claimed', 'started', 'linked']).catch(() => [] as FireRow[]);
      for (const row of rows) {
        const ev = relayEvidence(row);
        if (!ev || ev.lock_cleared) continue;
        const progress = Date.parse(ev.last_progress_at ?? row.fired_at ?? '');
        if (!Number.isFinite(progress) || now - progress < STALL_MS) continue;
        const next: RelayEvidence = { ...ev, v: ev.v + 1, lock_cleared: { by: 'cto-relay-muse', at: iso(now) } };
        const ok = await this.brain.patchFireRow(row.id, { evidence: next }, { version: ev.v }).catch(() => null);
        if (ok) this.log.info('stalled lock cleared', { cto: cto.key, fireId: row.id });
      }
    }
  }

  /** 9am: the daily open in #cto-bots — what is open, what each CTO owes, pending starts, and sweep warnings. */
  async dailyOpen(): Promise<void> {
    const now = this.clock();
    const open: string[] = [];
    const owed: string[] = [];
    const pending: string[] = [];
    for (const cto of this.ctos()) {
      const closed = await this.brain.listFireRows(cto.agentName, ['closed']).catch(() => [] as FireRow[]);
      for (const row of closed) {
        if (now - Date.parse(row.completed_at ?? '') > DAY) continue;
        const items = (relayEvidence(row)?.closeout?.still_open ?? 'None').split(';').map((s) => s.trim()).filter((s) => s && s !== 'None');
        for (const it of items) {
          open.push(`${cto.displayName}: ${it}`);
          const m = /Owner:\s*(.+?)\.?$/i.exec(it);
          if (m?.[1]) owed.push(`${m[1]} — ${it.replace(/\s*Owner:.*$/i, '')}`);
        }
      }
      const queued = await this.brain.listFireRows(cto.agentName, ['queued']).catch(() => [] as FireRow[]);
      for (const row of queued) pending.push(`${cto.displayName} — fire id ${row.id}`);
    }
    const byId = new Map<string, string>(this.registry.ctos.map((c) => [c.key, c.displayName]));
    const stalled = this.findings.map((f) => `${byId.get(f.cto) ?? f.cto} fire id ${f.fireId}${f.kind === 'unclosed' ? ' (not closed after 24 hours)' : ''}`);
    await this.poster.post(this.registry.ctoBotsChannelId, T.dailyOpen(open, owed, pending, stalled), 'template');
  }

  /**
   * Nightly: brain rows are retained 90 days, then archived to the vault (D6
   * store table). R7-FU-12 — home and format: terminal start rows older than
   * 90 days are exported to /var/lib/cto-relay/muse/archive/brain-archive-<YYYY-MM>.jsonl
   * (JSON lines, one full agent_comms row per line, task text in `body`) and marked
   * `archived_at`. The nightly cto-relay-offhost-copy.sh files that directory into
   * the vault at $VAULT_ARCHIVE_PATH within a day, where the retrieval test can
   * find it. Rows are NOT deleted from the brain: deletion after archive is a
   * COUNCIL GATE decision.
   */
  async archiveOldRows(dir: string): Promise<number> {
    const now = this.clock();
    let n = 0;
    for (const cto of this.ctos()) {
      const rows = await this.brain.listFireRows(cto.agentName, ['closed', 'failed', 'expired', 'refused', 'cancelled']).catch(() => [] as FireRow[]);
      for (const row of rows) {
        const ev = relayEvidence(row);
        const done = Date.parse(row.completed_at ?? row.fired_at ?? '');
        if (!ev || ev.archived_at || !Number.isFinite(done) || now - done < BRAIN_ROW_RETENTION_MS) continue;
        const month = iso(now).slice(0, 7);
        appendLineSync(join(dir, `brain-archive-${month}.jsonl`), JSON.stringify(row), 0o640);
        const ok = await this.brain.patchFireRow(row.id, { evidence: { ...ev, v: ev.v + 1, archived_at: iso(now) } }, { version: ev.v }).catch(() => null);
        if (ok) n++;
      }
    }
    return n;
  }

  /**
   * R7-NEW-5 — breaks the dead-alerter circle. The mini poller writes its own
   * cto_heartbeat row (agent MINI-POLLER) every minute; this program checks it
   * every minute. Stale over 5 minutes → alert + visible post in #cto-bots, once
   * per incident. If BOTH this program and the poller are down, Claude CTO's
   * own 9am check-in (`cto-relay checkin-report`) shows both stale heartbeats.
   */
  async watchPoller(): Promise<void> {
    let age: number;
    try {
      const hb = await this.brain.getHeartbeat(POLLER_AGENT);
      age = hb ? this.clock() - Date.parse(hb.heartbeat_at) : Number.POSITIVE_INFINITY;
    } catch {
      return; // brain down: the lease rule already stops this program
    }
    if (age > POLLER_STALE_MS && !this.pollerDown) {
      this.pollerDown = true;
      this.alert('mini-poller-stale', { ageMs: Number.isFinite(age) ? age : null });
      await this.poster.post(this.registry.ctoBotsChannelId, T.pollerDown(), 'template');
    } else if (age <= POLLER_STALE_MS && this.pollerDown) {
      this.pollerDown = false;
      await this.poster.post(this.registry.ctoBotsChannelId, T.pollerBack(), 'template');
    }
  }

  /**
   * R5-FU-9 — the nightly off-host copy check against the brain rows. `copyIds`
   * are the fire ids found in last night's journal copy for `cto`. Any brain row
   * fired 1–23 hours ago (not refused) with no id in the copy is a gap: posted in
   * #cto-bots and alerted.
   */
  async copyCheck(cto: CtoEntry, copyIds: string[]): Promise<{ gap: number }> {
    const now = this.clock();
    const seen = new Set(copyIds);
    const statuses = ['queued', 'claimed', 'started', 'linked', 'closed', 'failed', 'expired', 'cancelled'];
    const rows = await this.brain.listFireRows(cto.agentName, statuses);
    const gap = rows.filter((r) => {
      const at = Date.parse(r.fired_at ?? '');
      return Number.isFinite(at) && now - at >= HOUR && now - at <= 23 * HOUR && !seen.has(r.id);
    });
    if (gap.length > 0) {
      this.alert('offhost-copy-gap', { cto: cto.key, gap: gap.length });
      await this.poster.post(this.registry.ctoBotsChannelId, T.copyGap(cto, gap.length), 'template');
    }
    return { gap: gap.length };
  }

  /** Every minute: the visible failure for a sibling program that is down (e.g. its token was revoked). */
  async watchSiblings(): Promise<void> {
    for (const cto of this.ctos()) {
      if (cto.key === 'muse') continue;
      const up = await this.fetchHealth(cto.healthPort).catch(() => false);
      if (up) {
        this.siblingFails.set(cto.key, 0);
        if (this.siblingDown.delete(cto.key)) await this.poster.post(this.registry.ctoBotsChannelId, T.relayBack(cto), 'template');
        continue;
      }
      const n = (this.siblingFails.get(cto.key) ?? 0) + 1;
      this.siblingFails.set(cto.key, n);
      if (n >= 3 && !this.siblingDown.has(cto.key)) {
        this.siblingDown.add(cto.key);
        this.alert('sibling-relay-down', { cto: cto.key });
        await this.poster.post(this.registry.ctoBotsChannelId, T.relayDown(cto), 'template');
      }
    }
  }
}
