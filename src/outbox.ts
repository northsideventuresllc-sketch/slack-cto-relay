// Durable close-out outbox (D5 step 5). When the vault path cannot be read
// back, nothing is posted claiming completion: the map waits here.
// Retry every 5 minutes × 12, then hourly × 24, TTL 7 days. Rebuilt from the
// journal (+ the brain row's close-out request) if an entry is corrupt.
// Holds ids, hashes and the vault path, plus only close-out fields already
// filed in the vault — never task text.

import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, writeFileAtomicSync } from './util/durable.js';
import { DAY, HOUR, MIN, iso } from './util/time.js';

export const OUTBOX_TTL_MS = 7 * DAY;
export const FAST_RETRIES = 12;
export const FAST_RETRY_MS = 5 * MIN;
export const SLOW_RETRIES = 24;
export const SLOW_RETRY_MS = HOUR;

export const OutboxEntrySchema = z.object({
  fireId: z.string(),
  vaultLogPath: z.string(),
  sessionUrl: z.string(),
  tokens: z.number().int().nonnegative().nullable(),
  minutes: z.number().nonnegative().nullable(),
  createdAt: z.string(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string(),
  step: z.enum(['readback', 'pointer', 'done']),
  logHash: z.string().nullable(),
  mapTs: z.string().nullable(),
  mapPermalink: z.string().nullable(),
  // vault-filed fields only:
  done: z.string().nullable(),
  stillOpen: z.string().nullable(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** Next attempt time after `attempts` failures, or null when the schedule (12 fast + 24 slow) is spent. */
export function nextAttemptDelay(attempts: number): number | null {
  if (attempts < FAST_RETRIES) return FAST_RETRY_MS;
  if (attempts < FAST_RETRIES + SLOW_RETRIES) return SLOW_RETRY_MS;
  return null;
}

export class Outbox {
  readonly dir: string;
  corruptOnLoad: string[] = [];

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'outbox');
    ensureDir(this.dir);
  }

  private file(fireId: string): string {
    return join(this.dir, `${fireId.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
  }

  put(e: OutboxEntry): void {
    writeFileAtomicSync(this.file(e.fireId), JSON.stringify(OutboxEntrySchema.parse(e)));
  }

  remove(fireId: string): void {
    const f = this.file(fireId);
    if (existsSync(f)) unlinkSync(f);
  }

  get(fireId: string): OutboxEntry | null {
    const f = this.file(fireId);
    if (!existsSync(f)) return null;
    const r = OutboxEntrySchema.safeParse(JSON.parse(readFileSync(f, 'utf8')));
    return r.success ? r.data : null;
  }

  /** All valid entries; corrupt files are recorded (by fire id) for rebuild and moved aside. */
  list(): OutboxEntry[] {
    this.corruptOnLoad = [];
    const out: OutboxEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const f = join(this.dir, name);
      try {
        out.push(OutboxEntrySchema.parse(JSON.parse(readFileSync(f, 'utf8'))));
      } catch {
        this.corruptOnLoad.push(name.replace(/\.json$/, ''));
        unlinkSync(f);
      }
    }
    return out;
  }

  /** Record a failed attempt; returns the updated entry, or null if the schedule or the TTL is spent. */
  failAttempt(e: OutboxEntry, nowMs: number): OutboxEntry | null {
    const attempts = e.attempts + 1;
    const delay = nextAttemptDelay(attempts);
    if (delay === null || nowMs - Date.parse(e.createdAt) >= OUTBOX_TTL_MS) {
      this.remove(e.fireId);
      return null;
    }
    const next = { ...e, attempts, nextAttemptAt: iso(nowMs + delay) };
    this.put(next);
    return next;
  }
}
