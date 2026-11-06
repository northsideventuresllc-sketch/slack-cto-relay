// The run log (D6): durable disk, fsynced on every write, ids and hashes only,
// 90-day retention. ONLY this module writes the run log; the poster calls
// slack-transport to send and run-log to record (D6 layers).
//
// D5: every start writes a `started` entry keyed by fire id (session id null
// until the link exists). R7-FU-5 — the fill mechanism: the run log is
// append-only; "filled on linked" is a NEW entry of kind `linked` with the same
// fire id and `sessionId` set (RunLogEntry below). Nothing is updated in place.
// The sweep matches on fire id, not session id.

import { join } from 'node:path';
import { appendLineSync, readJsonLines, writeFileAtomicSync } from './util/durable.js';
import { DAY, iso, type Clock } from './util/time.js';

export type RunLogKind = 'started' | 'state' | 'linked' | 'closeout' | 'cost' | 'post' | 'check' | 'expiry' | 'alert';

export interface RunLogEntry {
  at: string;
  kind: RunLogKind;
  fireId: string | null;
  cto: string;
  writer: string; // "adapter:<cto>" for state-changing entries by the CTO's own adapter, else "relay"
  state?: string;
  sessionId?: string | null; // run-chat id/link; null until linked
  taskHash?: string;
  check?: string; // D4 check-order step name, logged by id only
  result?: string;
  home?: string;
  tokens?: number | null; // null = unmetered
  minutes?: number | null;
  channelId?: string;
  ts?: string; // Slack message ts
  reason?: string;
}

export const RUN_LOG_RETENTION_MS = 90 * DAY;

export class RunLog {
  readonly path: string;
  readonly auditPath: string;

  constructor(
    stateDir: string,
    readonly cto: string,
    private readonly clock: Clock,
  ) {
    this.path = join(stateDir, 'run-log.jsonl');
    this.auditPath = join(stateDir, 'audit.jsonl');
  }

  write(entry: Omit<RunLogEntry, 'at' | 'cto'>): RunLogEntry {
    const e: RunLogEntry = { at: iso(this.clock()), cto: this.cto, ...entry };
    appendLineSync(this.path, JSON.stringify(e));
    return e;
  }

  started(fireId: string, taskHash: string, adapterKey: string, fromProvisionalId?: string): void {
    this.write({ kind: 'started', fireId, taskHash, sessionId: null, writer: `adapter:${adapterKey}`, state: 'started-entry', ...(fromProvisionalId ? { reason: `from:${fromProvisionalId}` } : {}) });
  }

  /** A state-changing entry written by the CTO's own adapter (claim, start, link, close-out) — refreshes the lock (D4). */
  progress(fireId: string, state: string, adapterKey: string, sessionId?: string | null): void {
    this.write({ kind: state === 'linked' ? 'linked' : 'state', fireId, state, writer: `adapter:${adapterKey}`, sessionId: sessionId ?? null });
  }

  /** One cost line per start (D4 cost envelope): CTO, task hash, home, tokens used, minutes taken. */
  cost(fireId: string, taskHash: string, home: string, tokens: number | null, minutes: number | null): void {
    this.write({ kind: 'cost', fireId, taskHash, home, tokens, minutes, writer: 'relay' });
  }

  /** D4: "Each check is logged by id only." */
  check(fireIdOrEvent: string | null, check: string, result: string): void {
    this.write({ kind: 'check', fireId: fireIdOrEvent, check, result, writer: 'relay' });
  }

  /** Audit log: ids, hashes, and redacted text of at most 80 characters (the caller redacts). */
  audit(fields: { fireId?: string | null; eventKey?: string; action: string; snippet?: string }): void {
    const snippet = fields.snippet && fields.snippet.length > 80 ? fields.snippet.slice(0, 80) : fields.snippet;
    appendLineSync(this.auditPath, JSON.stringify({ at: iso(this.clock()), cto: this.cto, ...fields, snippet }));
  }

  entries(): RunLogEntry[] {
    return readJsonLines(this.path).values as RunLogEntry[];
  }

  /** Last state-changing entry written by this CTO's own adapter for a fire. */
  lastProgress(fireId: string): number | null {
    let last: number | null = null;
    for (const e of this.entries()) {
      if (e.fireId === fireId && e.writer.startsWith('adapter:')) last = Date.parse(e.at);
    }
    return last;
  }

  /** Retention (90 days for the run log and the audit log). */
  prune(): void {
    const now = this.clock();
    for (const p of [this.path, this.auditPath]) {
      const { values } = readJsonLines(p);
      const keep = values.filter((v) => {
        const at = Date.parse((v as { at?: string }).at ?? '');
        return Number.isFinite(at) && now - at < RUN_LOG_RETENTION_MS;
      });
      if (keep.length !== values.length) writeFileAtomicSync(p, keep.map((v) => JSON.stringify(v)).join('\n') + (keep.length ? '\n' : ''));
    }
  }
}
