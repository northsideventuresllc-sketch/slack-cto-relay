// Per-event safety (D6). Each event is validated and try/caught on its own.
// The same event failing 5 times is quarantined: quarantine.jsonl gets event id
// + text hash + reason — never event text — and the event is skipped.
// Start-pattern events are EXEMPT from quarantine entirely: a start-pattern
// event that fails 5 times gets a failure reply the same day, an alert to Muse
// CTO, and ONE retry after 1 hour; if that fails, a second failure reply +
// alert, and it is dropped — never re-quarantined.

import { join } from 'node:path';
import { appendLineSync, readJsonLines, writeFileAtomicSync } from './util/durable.js';
import { DAY, HOUR, iso, type Clock } from './util/time.js';

export const MAX_EVENT_FAILURES = 5;
export const START_RETRY_DELAY_MS = HOUR;
export const QUARANTINE_RETENTION_MS = 7 * DAY;

export const REPLY_START_FAILED_FIRST = 'Could not start this. Muse CTO has been told. One more try in 1 hour.';
export const REPLY_START_FAILED_FINAL = 'Could not start this after one more try. Muse CTO has been told. Please re-send it.';

export class Quarantine {
  readonly path: string;
  private failures = new Map<string, number>();
  private retried = new Set<string>();

  constructor(stateDir: string, private readonly clock: Clock) {
    this.path = join(stateDir, 'quarantine.jsonl');
  }

  /** Record one failed attempt; returns the failure count so far. */
  fail(eventKey: string): number {
    const n = (this.failures.get(eventKey) ?? 0) + 1;
    this.failures.set(eventKey, n);
    return n;
  }

  clear(eventKey: string): void {
    this.failures.delete(eventKey);
  }

  /** Non-start events only. Start-pattern events must never reach this. */
  quarantine(eventId: string, textHash: string, reason: string): void {
    appendLineSync(this.path, JSON.stringify({ at: iso(this.clock()), eventId, textHash, reason }));
  }

  /** True the first time a start-pattern event's single retry is claimed; false after (retries capped at one). */
  claimStartRetry(eventKey: string): boolean {
    if (this.retried.has(eventKey)) return false;
    this.retried.add(eventKey);
    return true;
  }

  prune(): void {
    const now = this.clock();
    const { values } = readJsonLines(this.path);
    const keep = values.filter((v) => now - Date.parse((v as { at?: string }).at ?? '') < QUARANTINE_RETENTION_MS);
    if (keep.length !== values.length) writeFileAtomicSync(this.path, keep.map((v) => JSON.stringify(v)).join('\n') + (keep.length ? '\n' : ''));
  }
}
