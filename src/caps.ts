// Cost envelope (D4): the ceiling is enforced on COUNT by the relay (hard stop
// on starts per day and per month), reported on tokens. Caps are totals across
// all four CTOs (counted from the brain rows every program can see), plus the
// per-CTO weekly cap for manual CTOs and the overrun block. The lower binds.

import type { BrainApi } from './brain.js';
import { effectiveDailyCap, type Caps, type CtoEntry } from './config.js';
import type { Journal } from './journal.js';
import { iso, startOfLocalDay, startOfLocalMonth, startOfLocalWeek } from './util/time.js';

export type CapVerdict = { kind: 'ok' } | { kind: 'refused'; cap: 'daily' | 'monthly' | 'weekly-per-cto' | 'overrun'; reply: string };

export const REPLY_CAP_DAILY = 'Not started. The daily start limit is reached. It resets at midnight.';
export const REPLY_CAP_MONTHLY = 'Not started. The monthly start limit is reached.';
export const REPLY_CAP_WEEKLY = 'Not started. This CTO has used its starts for the week.';
export const REPLY_OVERRUN = 'Not started. The last run went over its token budget. Starts resume after the Monday review.';

export class CostEnvelope {
  constructor(
    private readonly caps: Caps,
    private readonly cto: CtoEntry,
    private readonly journal: Journal,
    private readonly tz: string,
  ) {}

  /** Overrun block: an `overrun` record not yet followed by a `review-cleared` record. */
  overrunBlocked(): boolean {
    let blocked = false;
    for (const r of this.journal.all()) {
      if (r.kind !== 'fire-state') continue;
      if (r.state === 'overrun') blocked = true;
      if (r.state === 'review-cleared') blocked = false;
    }
    return blocked;
  }

  async check(brain: BrainApi, nowMs: number): Promise<CapVerdict> {
    if (this.overrunBlocked()) return { kind: 'refused', cap: 'overrun', reply: REPLY_OVERRUN };
    const day = await brain.countStarts(iso(startOfLocalDay(nowMs, this.tz)));
    if (day >= effectiveDailyCap(this.caps)) return { kind: 'refused', cap: 'daily', reply: REPLY_CAP_DAILY };
    const month = await brain.countStarts(iso(startOfLocalMonth(nowMs, this.tz)));
    if (month >= this.caps.monthlyStartCapTotal) return { kind: 'refused', cap: 'monthly', reply: REPLY_CAP_MONTHLY };
    if (this.cto.adapter === 'manual') {
      const week = await brain.countStarts(iso(startOfLocalWeek(nowMs, this.tz)), this.cto.agentName);
      if (week >= this.caps.perCtoWeeklyManualCap) return { kind: 'refused', cap: 'weekly-per-cto', reply: REPLY_CAP_WEEKLY };
    }
    return { kind: 'ok' };
  }

  /** Close-out: a run over the per-fire budget finishes; the overrun is flagged and the next start is refused until the Monday review. */
  isOverrun(tokens: number | null): boolean {
    return tokens !== null && tokens > this.caps.perFireTokenBudget;
  }
}
