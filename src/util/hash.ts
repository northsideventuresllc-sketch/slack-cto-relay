import { createHash } from 'node:crypto';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Task normalization (D4 circuit breaker): normalize Unicode (NFKC), lowercase,
 * strip punctuation, collapse whitespace. "Deploy X" and "deploy X!" match.
 */
export function normalizeTask(task: string): string {
  return task
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** SHA-256 of the normalized task — the only form of a task the journal holds for dedup and the breaker. */
export function normalizedTaskHash(task: string): string {
  return sha256(normalizeTask(task));
}
