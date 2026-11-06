// The start-request journal (D4/D6): append-only, newline-delimited JSON, one
// record per line, fsynced on every write. Holds ids, hashes and states only —
// never task text. It is the ORDER record; the brain row is the CONTENT record.

import { z } from 'zod';
import type { FireJournalState, JournalRecord } from './contracts.js';
import { appendLineSync, readJsonLines, writeFileAtomicSync } from './util/durable.js';
import { DAY, iso, type Clock } from './util/time.js';

const FIRE_STATES = [
  'brain-written',
  'claimed',
  'started',
  'linked',
  'done',
  'closed',
  'failed',
  'expired',
  'refused',
  'cancelled',
  'abort-requested',
  'stop-requested',
  'lock-cleared',
  'overrun',
  'review-cleared',
  'reply-posted',
  'link-posted',
  'lost-notified',
  'closeout-requested',
  'retry-pending',
  'retry-done',
  'breaker-replied',
] as const satisfies readonly FireJournalState[];

const HEX64 = /^[0-9a-f]{64}$/;

export const JournalRecordSchema = z.object({
  kind: z.enum(['fire-request', 'fire-state', 'breaker-count']),
  fireId: z.string().min(1),
  hash: z.string().regex(HEX64).or(z.literal('')),
  timestamp: z.string().datetime(),
  claimName: z.string().max(80).optional(),
  windowStart: z.string().datetime().optional(),
  cto: z.string().optional(),
  state: z.enum(FIRE_STATES).optional(),
  channelId: z.string().max(32).optional(),
  normHash: z.string().regex(HEX64).optional(),
  idemKey: z.string().regex(HEX64).optional(),
  eventKey: z.string().regex(HEX64).optional(),
  provisional: z.boolean().optional(),
  brainId: z.string().optional(),
  closeoutKey: z.string().regex(HEX64).optional(),
  reason: z.string().max(64).regex(/^[a-z0-9:_-]+$/).optional(),
});

/** Dedup windows and close-out key retention (D6 nightly compaction). */
export const DEDUP_RETENTION_MS = DAY;
export const CLOSEOUT_KEY_RETENTION_MS = 90 * DAY;

/** Terminal journal states: the fire no longer holds the already-running lock. */
export const TERMINAL_JOURNAL_STATES: ReadonlySet<FireJournalState> = new Set<FireJournalState>([
  'closed',
  'failed',
  'expired',
  'refused',
  'cancelled',
  'retry-done', // a start-retry marker is over (R7-NEW-3); purged with the dedup window
  'breaker-replied', // the breaker's single trip reply went out (OPT-FU-4); purged with the dedup window
]);

export type JournalInput = Omit<JournalRecord, 'timestamp'>;

/** Hook used by the journal-failure test (Phase 2/5): make the next write throw. */
export interface JournalFaults {
  failNextWrite?: boolean;
}

export class Journal {
  private recs: JournalRecord[] = [];
  readonly faults: JournalFaults = {};
  badLinesOnLoad = 0;

  constructor(
    readonly path: string,
    private readonly clock: Clock,
  ) {}

  load(): void {
    const { values, badLines } = readJsonLines(this.path);
    const out: JournalRecord[] = [];
    let bad = badLines;
    for (const v of values) {
      const r = JournalRecordSchema.safeParse(v);
      if (r.success) out.push(r.data as JournalRecord);
      else bad++;
    }
    this.recs = out;
    this.badLinesOnLoad = bad;
  }

  /**
   * Append one record and fsync it. The timestamp is the journal write time —
   * the one timestamp used for abort-vs-claim comparisons (D4).
   * Throws if the write fails; the caller decides what that means (void the brain row first).
   */
  append(input: JournalInput): JournalRecord {
    const rec: JournalRecord = { ...input, timestamp: iso(this.clock()) };
    const parsed = JournalRecordSchema.parse(rec) as JournalRecord;
    if (this.faults.failNextWrite) {
      this.faults.failNextWrite = false;
      throw Object.assign(new Error('journal write failed (injected)'), { code: 'EJOURNAL_INJECTED' });
    }
    appendLineSync(this.path, JSON.stringify(parsed));
    this.recs.push(parsed);
    return parsed;
  }

  all(): readonly JournalRecord[] {
    return this.recs;
  }

  /** Resolve a provisional (brain-down) fire id to its brain-row id, if the brain write has landed. */
  resolveId(fireId: string): string {
    for (const r of this.recs) {
      if (r.kind === 'fire-state' && r.state === 'brain-written' && r.fireId === fireId && r.brainId) return r.brainId;
    }
    return fireId;
  }

  /** Every record that belongs to one fire, following the provisional → brain id mapping. */
  historyOf(fireId: string): JournalRecord[] {
    const ids = new Set([fireId]);
    for (const r of this.recs) {
      if (r.kind === 'fire-state' && r.state === 'brain-written' && r.brainId) {
        if (ids.has(r.fireId)) ids.add(r.brainId);
        if (ids.has(r.brainId)) ids.add(r.fireId);
      }
    }
    return this.recs.filter((r) => r.kind !== 'breaker-count' && ids.has(r.fireId));
  }

  hasFireRequest(fireId: string): boolean {
    return this.historyOf(fireId).some((r) => r.kind === 'fire-request');
  }

  /**
   * Nightly compaction (D6): purge dedup entries older than 24 hours and
   * close-out keys older than 90 days. A fire that is not terminal is never
   * purged. Breaker-count records past 24 hours are purged (their 10-minute
   * window is long over). The rewrite is atomic (tmp + fsync + rename).
   */
  compact(): { before: number; after: number } {
    const now = this.clock();
    const before = this.recs.length;
    const byFire = new Map<string, JournalRecord[]>();
    for (const r of this.recs) {
      if (r.kind === 'breaker-count') continue;
      const id = this.resolveId(r.fireId);
      const list = byFire.get(id) ?? [];
      list.push(r);
      byFire.set(id, list);
    }
    const keep = new Set<JournalRecord>();
    for (const r of this.recs) {
      if (r.kind === 'breaker-count' && now - Date.parse(r.timestamp) < DEDUP_RETENTION_MS) keep.add(r);
    }
    for (const list of byFire.values()) {
      const terminal = list.some((r) => r.kind === 'fire-state' && r.state && TERMINAL_JOURNAL_STATES.has(r.state));
      const last = Math.max(...list.map((r) => Date.parse(r.timestamp)));
      if (!terminal || now - last < DEDUP_RETENTION_MS) {
        list.forEach((r) => keep.add(r));
        continue;
      }
      // Terminal and past the dedup window: keep only the close-out key, for 90 days.
      for (const r of list) {
        if (r.closeoutKey && now - Date.parse(r.timestamp) < CLOSEOUT_KEY_RETENTION_MS) keep.add(r);
      }
    }
    // Review flags (overrun / review-cleared) are kept until superseded.
    const lastReview = [...this.recs].reverse().find((r) => r.state === 'overrun' || r.state === 'review-cleared');
    if (lastReview) keep.add(lastReview);

    const next = this.recs.filter((r) => keep.has(r));
    writeFileAtomicSync(this.path, next.map((r) => JSON.stringify(r)).join('\n') + (next.length ? '\n' : ''));
    this.recs = next;
    return { before, after: next.length };
  }
}
