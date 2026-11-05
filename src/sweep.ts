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

/**
 * The still-active test (D5 close signal). A run is still active if ANY holds:
 * (a) the adapter's status(runId) reports the run as live (not closed/failed/expired);
 * (b) the CTO's channel has a message from that CTO in the last 6 hours;
 * (c) the brain row status is `started` AND the last run-log entry was written
 *     by the CTO's own adapter in the last 6 hours.
 */
export function stillActive(input: { adapterState: string; channelMsgAt: number | null; rowStatus: string; lastAdapterEntryAt: number | null; now: number }): boolean {
  const a = !['closed', 'failed', 'expired', 'cancelled', 'refused'].includes(input.adapterState);
  const b = input.channelMsgAt !== null && input.now - input.channelMsgAt < STALL_MS;
  const c = input.rowStatus === 'started' && input.lastAdapterEntryAt !== null && input.now - input.lastAdapterEntryAt < STALL_MS;
  return a || b || c;
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

  /** Every 6 hours. Flags (1) stalled-and-unclosed and (2) unclosed, separately. Matches on fire id. */
  async sweep(): Promise<SweepFinding[]> {
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
        const progress = ev?.last_progress_at ? Date.parse(ev.last_progress_at) : Date.parse(row.fired_at ?? '');
        const lastActivity = Math.max(Number.isFinite(progress) ? progress : 0, msgAt ?? 0);
        if (now - lastActivity >= STALL_MS) out.push({ cto: cto.key, fireId: row.id, kind: 'stalled' });
        const active = stillActive({ adapterState: row.status ?? '', channelMsgAt: msgAt, rowStatus: row.status ?? '', lastAdapterEntryAt: Number.isFinite(progress) ? progress : null, now });
        if (now - lastActivity > UNCLOSED_MS && !active) out.push({ cto: cto.key, fireId: row.id, kind: 'unclosed' });
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
   * store table). Terminal start rows older than 90 days are exported to
   * <mirrorDir>/brain-archive-<YYYY-MM>.jsonl (filed into the vault weekly with
   * the mirror) and marked `archived_at`. Rows are NOT deleted from the brain:
   * deletion after archive is a COUNCIL GATE decision.
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
