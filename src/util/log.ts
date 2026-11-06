// Process log (journald via stdout). Ids, hashes and machine codes only — never
// task text, event text, or any key (D6 redaction). Fields named like secrets
// are dropped defensively.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const FORBIDDEN_FIELDS = new Set(['token', 'apptoken', 'bottoken', 'brainkey', 'secret', 'apikey', 'authorization', 'password', 'text', 'task', 'body', 'value']);

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(component: string, level: Level = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const safe: Record<string, unknown> = {};
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (FORBIDDEN_FIELDS.has(k.toLowerCase())) continue;
        safe[k] = v instanceof Error ? errorCode(v) : v;
      }
    }
    sink(JSON.stringify({ t: new Date().toISOString(), lvl, c: component, msg, ...safe }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** A short machine description of an error — the class/code, never a message that may echo input. */
export function errorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown; data?: { error?: unknown } };
    const parts = [e.name, e.code, e.data?.error].filter((p) => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(':');
  }
  return 'error';
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
