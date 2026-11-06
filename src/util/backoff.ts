// Backoff (D6): 1s / 2s / 4s / 8s between tries, then fail. Slack 429s use
// Slack's own delay. Retries reuse the same idempotency key, so a retry cannot
// double-run. Adapter starts are never retried (callers do not wrap fire()).

export const POST_BACKOFF_MS = [1000, 2000, 4000, 8000] as const;
export const SOCKET_RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error that carries Slack's own retry delay (HTTP 429 Retry-After, seconds). */
export interface RateLimited {
  retryAfterSec: number;
}

export function rateLimitOf(err: unknown): RateLimited | null {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; retryAfter?: unknown };
    if (e.code === 'slack_webapi_rate_limited_error' && typeof e.retryAfter === 'number') {
      return { retryAfterSec: e.retryAfter };
    }
  }
  return null;
}

/** Errors that must never be retried (bad input, revoked token, not in channel). */
export function isPermanent(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; data?: { error?: unknown } };
    if (e.code === 'slack_webapi_platform_error') {
      const code = typeof e.data?.error === 'string' ? e.data.error : '';
      return [
        'invalid_auth',
        'token_revoked',
        'account_inactive',
        'not_authed',
        'channel_not_found',
        'not_in_channel',
        'is_archived',
        'msg_too_long',
        'no_text',
        'restricted_action',
      ].includes(code);
    }
  }
  return false;
}

/**
 * Run `op` with the D6 backoff. Throws the last error after the final try.
 * A 429 waits Slack's own delay instead of the schedule step.
 */
export async function withBackoff<T>(op: () => Promise<T>, sleep: Sleep = realSleep): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= POST_BACKOFF_MS.length; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (isPermanent(err)) throw err;
      if (attempt === POST_BACKOFF_MS.length) break;
      const rl = rateLimitOf(err);
      const delay = rl ? rl.retryAfterSec * 1000 : (POST_BACKOFF_MS[attempt] ?? 8000);
      await sleep(delay);
    }
  }
  throw lastErr;
}
