// Dedup precedence (D6): event dedup → idempotency key → task dedup.
//   event dedup: event id; if absent, trigger id; if absent, channel + user + text hash + minute. 24-hour TTL.
//   idempotency key: CTO + normalized task + minute bucket.
//   task dedup: same CTO + normalized task within 30 minutes runs once.
// State reloads from the journal's fire-request records on restart; keys are SHA-256 hashes.

import type { JournalRecord } from './contracts.js';
import type { SlackEvent } from './contracts.js';
import { sha256, normalizeTask } from './util/hash.js';
import { DAY, MIN } from './util/time.js';

export const EVENT_DEDUP_TTL_MS = DAY;
export const TASK_DEDUP_WINDOW_MS = 30 * MIN;

/** States after which a start never ran, so it does not block a re-send under task dedup. */
const NEVER_RAN = new Set(['refused', 'cancelled', 'failed', 'expired']);

export function eventKey(ev: SlackEvent, nowMs: number): string {
  if (ev.eventId) return sha256(`event:${ev.eventId}`);
  if (ev.triggerId) return sha256(`trigger:${ev.triggerId}`);
  const minute = Math.floor(nowMs / MIN);
  return sha256(`ctx:${ev.channelId}:${ev.authorId}:${sha256(ev.text)}:${minute}`);
}

export function idempotencyKey(cto: string, task: string, nowMs: number): string {
  const minute = Math.floor(nowMs / MIN);
  return sha256(`idem:${cto}:${normalizeTask(task)}:${minute}`);
}

export type DedupVerdict = 'ok' | 'event-duplicate' | 'idempotency-duplicate' | 'task-duplicate';

interface Seen {
  at: number;
  fireId: string | null;
}

export class Dedup {
  private events = new Map<string, number>();
  private idem = new Map<string, number>();
  private tasks = new Map<string, Seen[]>(); // normHash → accepted starts

  constructor(private readonly fireEnded: (fireId: string) => string | null) {}

  /** Rebuild from the journal (restart / takeover). */
  loadFromJournal(records: readonly JournalRecord[]): void {
    for (const r of records) {
      if (r.kind !== 'fire-request') continue;
      const at = Date.parse(r.timestamp);
      if (r.eventKey) this.events.set(r.eventKey, at);
      if (r.idemKey) this.idem.set(r.idemKey, at);
      if (r.normHash) this.pushTask(r.normHash, { at, fireId: r.fireId });
    }
  }

  private pushTask(h: string, s: Seen): void {
    const list = this.tasks.get(h) ?? [];
    list.push(s);
    this.tasks.set(h, list);
  }

  /** Checks in precedence order; records the event key so a redelivery is dropped. */
  check(evKey: string, idemKey: string, normHash: string, nowMs: number): DedupVerdict {
    this.gc(nowMs);
    if (this.events.has(evKey)) return 'event-duplicate';
    this.events.set(evKey, nowMs);
    if (this.idem.has(idemKey)) return 'idempotency-duplicate';
    const recent = (this.tasks.get(normHash) ?? []).filter((s) => nowMs - s.at < TASK_DEDUP_WINDOW_MS);
    const blocking = recent.filter((s) => {
      if (!s.fireId) return true;
      const end = this.fireEnded(s.fireId);
      return end === null || !NEVER_RAN.has(end);
    });
    if (blocking.length > 0) return 'task-duplicate';
    return 'ok';
  }

  /** The single start-event retry (1 h later) skips event dedup — the event key is its own — but keeps the other two. */
  checkRetry(idemKey: string, normHash: string, nowMs: number): DedupVerdict {
    this.gc(nowMs);
    if (this.idem.has(idemKey)) return 'idempotency-duplicate';
    const recent = (this.tasks.get(normHash) ?? []).filter((s) => nowMs - s.at < TASK_DEDUP_WINDOW_MS);
    const blocking = recent.filter((s) => {
      if (!s.fireId) return true;
      const end = this.fireEnded(s.fireId);
      return end === null || !NEVER_RAN.has(end);
    });
    return blocking.length > 0 ? 'task-duplicate' : 'ok';
  }

  /** Roll back an event key when processing threw, so the in-process retry is not mistaken for a redelivery. */
  forget(evKey: string): void {
    this.events.delete(evKey);
  }

  /** Record an ACCEPTED start (after its journal write). */
  accept(idemKey: string, normHash: string, fireId: string, nowMs: number): void {
    this.idem.set(idemKey, nowMs);
    this.pushTask(normHash, { at: nowMs, fireId });
  }

  private gc(nowMs: number): void {
    for (const [k, at] of this.events) if (nowMs - at >= EVENT_DEDUP_TTL_MS) this.events.delete(k);
    for (const [k, at] of this.idem) if (nowMs - at >= EVENT_DEDUP_TTL_MS) this.idem.delete(k);
    for (const [k, list] of this.tasks) {
      const keep = list.filter((s) => nowMs - s.at < TASK_DEDUP_WINDOW_MS);
      if (keep.length) this.tasks.set(k, keep);
      else this.tasks.delete(k);
    }
  }
}
