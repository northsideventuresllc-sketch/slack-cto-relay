// The per-CTO queue (D6): max 10, journal-backed. Each entry has a stable id
// (the fire id) and an idempotency key. Order comes from the journal; content
// (task text) stays in the brain rows — except a brain-down start, whose text
// is held IN MEMORY ONLY until the brain write lands (D4 Muse adapter).

import type { FireJournalState, JournalRecord } from './contracts.js';
import { TERMINAL_JOURNAL_STATES } from './journal.js';
import { DAY } from './util/time.js';

export const QUEUE_MAX = 10;
export const LOCK_TTL_MS = DAY; // already-running lock expires 24 h after the run started, unless refreshed

/** States that count as a state-changing run-log entry by the CTO's own adapter — they refresh the lock (D4). */
const PROGRESS_STATES: ReadonlySet<FireJournalState> = new Set<FireJournalState>(['claimed', 'started', 'linked', 'closed']);

export interface FireEntry {
  id: string; // current fire id: the brain-row id, or a provisional id while the brain is down
  provisionalId: string | null;
  provisional: boolean;
  taskHash: string;
  normHash: string;
  idemKey: string;
  channelId: string;
  acceptedAt: number;
  state: FireJournalState | 'requested';
  terminal: boolean;
  replyPosted: boolean;
  linkPosted: boolean;
  claimAt: number | null;
  claimName: string | null;
  abortAt: number | null;
  startedAt: number | null;
  lastProgressAt: number;
  lockCleared: boolean;
  lostNotified: boolean;
  // memory only — never written to disk:
  heldTask: string | null;
  nextBrainRetryAt: number | null;
  noticesSent: Set<string>;
}

export class FireBook {
  private byId = new Map<string, FireEntry>();
  private order: string[] = []; // journal order

  /** Apply one journal record (load or live). */
  apply(r: JournalRecord): void {
    if (r.kind === 'breaker-count') return;
    const at = Date.parse(r.timestamp);
    if (r.kind === 'fire-request') {
      if (this.byId.has(r.fireId)) return;
      const e: FireEntry = {
        id: r.fireId,
        provisionalId: r.provisional ? r.fireId : null,
        provisional: !!r.provisional,
        taskHash: r.hash,
        normHash: r.normHash ?? '',
        idemKey: r.idemKey ?? '',
        channelId: r.channelId ?? '',
        acceptedAt: at,
        state: 'requested',
        terminal: false,
        replyPosted: false,
        linkPosted: false,
        claimAt: null,
        claimName: null,
        abortAt: null,
        startedAt: null,
        lastProgressAt: at,
        lockCleared: false,
        lostNotified: false,
        heldTask: null,
        nextBrainRetryAt: null,
        noticesSent: new Set(),
      };
      this.byId.set(e.id, e);
      this.order.push(e.id);
      return;
    }
    // fire-state
    const e = this.byId.get(r.fireId);
    if (!e || !r.state) return;
    switch (r.state) {
      case 'brain-written':
        if (r.brainId && e.provisional) {
          this.byId.delete(e.id);
          this.order = this.order.map((id) => (id === e.id ? r.brainId! : id));
          e.id = r.brainId;
          e.provisional = false;
          e.heldTask = null;
          e.nextBrainRetryAt = null;
          this.byId.set(e.id, e);
        }
        return;
      case 'reply-posted':
        e.replyPosted = true;
        return;
      case 'link-posted':
        e.linkPosted = true;
        return;
      case 'abort-requested':
        if (e.abortAt === null) e.abortAt = at;
        return;
      case 'lock-cleared':
        e.lockCleared = true;
        return;
      case 'lost-notified':
        e.lostNotified = true;
        return;
      case 'overrun':
      case 'review-cleared':
      case 'stop-requested':
      case 'closeout-requested':
        return;
      default:
        break;
    }
    e.state = r.state;
    if (r.state === 'claimed') {
      e.claimAt = at;
      e.claimName = r.claimName ?? null;
    }
    if (r.state === 'started' && e.startedAt === null) e.startedAt = at;
    if (PROGRESS_STATES.has(r.state)) e.lastProgressAt = at;
    if (TERMINAL_JOURNAL_STATES.has(r.state)) e.terminal = true;
  }

  load(records: readonly JournalRecord[]): void {
    this.byId.clear();
    this.order = [];
    for (const r of records) this.apply(r);
  }

  get(id: string): FireEntry | undefined {
    return this.byId.get(id) ?? [...this.byId.values()].find((e) => e.provisionalId === id);
  }

  /** Resolve a quoted fire id: exact, or a unique prefix of ≥8 characters among this CTO's fires. */
  resolveQuoted(quoted: string): FireEntry | undefined {
    const exact = this.get(quoted);
    if (exact) return exact;
    if (quoted.length < 8) return undefined;
    const hits = [...this.byId.values()].filter((e) => e.id.startsWith(quoted) || (e.provisionalId ?? '').startsWith(quoted));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** Non-terminal entries in journal order. */
  inFlight(): FireEntry[] {
    return this.order.map((id) => this.byId.get(id)).filter((e): e is FireEntry => !!e && !e.terminal);
  }

  all(): FireEntry[] {
    return this.order.map((id) => this.byId.get(id)).filter((e): e is FireEntry => !!e);
  }

  /** The already-running lock (D4): held until CLOSED, expires 24 h after start unless refreshed, cleared on a stalled run at 9am. */
  lockHolder(nowMs: number): FireEntry | undefined {
    return this.inFlight().find((e) => !e.lockCleared && nowMs - e.lastProgressAt < LOCK_TTL_MS);
  }

  depth(): number {
    return this.inFlight().length;
  }
}
