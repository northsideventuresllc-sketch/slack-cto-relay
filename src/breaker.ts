// Circuit breaker (D4): more than 3 accepted start attempts for the same task
// (same normalized task, same CTO) in 10 minutes stops starting for that task.
// Store: one append-only journal record per accepted attempt, kind
// `breaker-count` (CTO + SHA-256 of the normalized task + window start +
// attempt timestamp). On restart the program sums the records in the window.

import type { JournalRecord } from './contracts.js';
import type { Journal } from './journal.js';
import { MIN, iso } from './util/time.js';

export const BREAKER_WINDOW_MS = 10 * MIN;
export const BREAKER_MAX_ATTEMPTS = 3;
export const REPLY_BREAKER = 'Too many starts for this task. Stopped.';

export type BreakerVerdict = { kind: 'ok' } | { kind: 'tripped'; replyOnce: boolean };

export class Breaker {
  /** (normHash|windowStart) whose single trip reply has gone out. */
  private replied = new Set<string>();

  constructor(
    private readonly journal: Journal,
    private readonly cto: string,
  ) {}

  private attempts(normHash: string): JournalRecord[] {
    return this.journal.all().filter((r) => r.kind === 'breaker-count' && r.hash === normHash && r.cto === this.cto);
  }

  /** The current window for this task, or null if none is open at `nowMs`. */
  currentWindow(normHash: string, nowMs: number): { start: number; count: number } | null {
    const recs = this.attempts(normHash);
    let start: number | null = null;
    let count = 0;
    for (const r of recs) {
      const ws = Date.parse(r.windowStart ?? r.timestamp);
      if (nowMs - ws < BREAKER_WINDOW_MS && nowMs >= ws) {
        if (start === null || ws === start) {
          start = ws;
          count++;
        }
      }
    }
    return start === null ? null : { start, count };
  }

  check(normHash: string, nowMs: number): BreakerVerdict {
    const w = this.currentWindow(normHash, nowMs);
    if (!w || w.count < BREAKER_MAX_ATTEMPTS) return { kind: 'ok' };
    const key = `${normHash}|${w.start}`;
    const replyOnce = !this.replied.has(key);
    this.replied.add(key);
    return { kind: 'tripped', replyOnce };
  }

  /** Append the breaker-count record for an ACCEPTED attempt. */
  record(normHash: string, fireId: string, nowMs: number): void {
    const w = this.currentWindow(normHash, nowMs);
    const windowStart = w ? w.start : nowMs;
    this.journal.append({ kind: 'breaker-count', fireId, hash: normHash, cto: this.cto, windowStart: iso(windowStart) });
  }
}
