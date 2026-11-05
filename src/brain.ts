// The brain (Supabase NI Brain, project uaztknnipdxxptrmlxlb) via PostgREST.
// Tables touched — and ONLY these three (RUNBOOK Phase 1 deviation note):
//   agent_comms     (existing; 15 verified columns — there is NO payload and NO updated_at column)
//   cto_relay_lease (migration 0001)
//   cto_heartbeat   (migration 0001)
// Key placement: the `apikey` header only (RUNBOOK Phase 1 key store: placement
// custom_header:apikey; Bearer-only placement returned 401).

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Row shapes — real agent_comms columns, in the order recorded in RUNBOOK.md:
// id, created_at, from_agent, from_harness, to_agent, to_harness, channel,
// subject, body, status, fired_at, completed_at, evidence, parent_id, code.
// ---------------------------------------------------------------------------

export const AGENT_COMMS_COLUMNS = [
  'id',
  'created_at',
  'from_agent',
  'from_harness',
  'to_agent',
  'to_harness',
  'channel',
  'subject',
  'body',
  'status',
  'fired_at',
  'completed_at',
  'evidence',
  'parent_id',
  'code',
] as const;

/** `code` values the relay writes, so its rows are told apart from other agent mail. */
export const CODE_FIRE = 'cto-relay-fire';
export const CODE_ALERT = 'cto-relay-alert';
export const HARNESS_RELAY = 'cto-relay';
export const CHANNEL_SLACK = 'slack';

/** Brain-row statuses for a start (D4 manual state machine: who writes each). */
export const ROW_STATUSES = ['queued', 'claimed', 'started', 'linked', 'closed', 'failed', 'expired', 'refused', 'cancelled'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
export const TERMINAL_ROW_STATUSES: ReadonlySet<string> = new Set(['closed', 'failed', 'expired', 'refused', 'cancelled']);

/** The relay's block inside agent_comms.evidence (jsonb). Ids, hashes, links and states only. */
export const RelayEvidenceSchema = z.object({
  v: z.number().int().nonnegative(), // optimistic-concurrency version for read-modify-write
  cto: z.string(),
  task_hash: z.string(),
  norm_hash: z.string(),
  idem_key: z.string().optional(),
  epoch: z.number().int(),
  slack: z
    .object({ channel_id: z.string(), ts: z.string().nullable(), permalink: z.string().nullable() })
    .optional(),
  reply_ts: z.string().nullable().optional(),
  run_chat_url: z.string().nullable().optional(),
  link_posted_at: z.string().nullable().optional(),
  last_progress_at: z.string().optional(), // last state-changing entry by the CTO's own adapter
  claim: z.object({ name: z.string(), at: z.string() }).optional(),
  lock_cleared: z.object({ by: z.string(), at: z.string() }).optional(),
  closeout: z
    .object({
      requested_at: z.string(),
      vault_log_path: z.string(),
      session_url: z.string().nullable(),
      tokens: z.number().int().nonnegative().nullable(),
      minutes: z.number().nonnegative().nullable(),
      still_open: z.string().nullable().optional(), // filled after the vault read-back (vault-filed text only)
      map_permalink: z.string().nullable().optional(),
    })
    .optional(),
  writer: z.string().optional(),
});
export type RelayEvidence = z.infer<typeof RelayEvidenceSchema>;

export const FireRowSchema = z.object({
  id: z.string(),
  created_at: z.string().nullable().optional(),
  from_agent: z.string().nullable().optional(),
  from_harness: z.string().nullable().optional(),
  to_agent: z.string().nullable().optional(),
  to_harness: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  fired_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  evidence: z.unknown().optional(),
  parent_id: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
});
export type FireRow = z.infer<typeof FireRowSchema>;

export function relayEvidence(row: FireRow): RelayEvidence | null {
  const ev = row.evidence;
  if (!ev || typeof ev !== 'object') return null;
  const r = RelayEvidenceSchema.safeParse((ev as { relay?: unknown }).relay);
  return r.success ? r.data : null;
}

export const LeaseRowSchema = z.object({
  name: z.string(),
  epoch: z.number().int(),
  holder: z.string(),
  acquired_at: z.string(),
  heartbeat_at: z.string(),
  expires_at: z.string(),
});
export type LeaseRow = z.infer<typeof LeaseRowSchema>;

export const HeartbeatRowSchema = z.object({ agent: z.string(), heartbeat_at: z.string() });
export type HeartbeatRow = z.infer<typeof HeartbeatRowSchema>;

export interface NewFireRow {
  toAgent: string;
  fromAgent: string;
  toHarness: string;
  subject: string;
  body: string; // the task text — the brain row is the content record
  evidence: RelayEvidence;
  firedAt: string;
}

export interface FirePatch {
  status?: RowStatus;
  completed_at?: string | null;
  evidence?: RelayEvidence;
}

export interface FirePatchGuard {
  statusIn?: string[]; // only patch if the current status is one of these
  version?: number; // only patch if evidence.relay.v equals this
}

/**
 * Every brain operation the relay uses. DirectBrain talks PostgREST; the
 * manual CTOs' programs use BrokeredBrain (src/broker.ts), which forwards the
 * same calls to the Muse program — they never hold the brain key (D7).
 */
export interface BrainApi {
  ping(): Promise<void>;
  insertFireRow(row: NewFireRow): Promise<FireRow>;
  getFireRow(id: string): Promise<FireRow | null>;
  listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]>;
  findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null>;
  patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null>;
  countStarts(sinceIso: string, toAgent?: string): Promise<number>;
  insertAlertRow(toAgent: string, fromAgent: string, subject: string, body: string): Promise<void>;
  getLease(name: string): Promise<LeaseRow | null>;
  insertLease(row: LeaseRow): Promise<LeaseRow | null>; // null = a row already exists
  casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null>; // null = lost the race
  renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null>; // null = epoch is stale
  upsertHeartbeat(agent: string, at: string): Promise<void>;
  getHeartbeat(agent: string): Promise<HeartbeatRow | null>;
}

export class BrainError extends Error {
  constructor(
    readonly code: 'unreachable' | 'timeout' | 'http' | 'shape',
    readonly status: number | null,
  ) {
    super(`brain ${code}${status !== null ? ' ' + status : ''}`);
    this.name = 'BrainError';
  }
}

export interface DirectBrainOptions {
  supabaseUrl: string; // <SUPABASE_URL>, from the environment
  apiKey: string; // read from the tmpfs credential file, never logged
  httpsProxy?: string | null;
  timeoutMs?: number;
}

export class DirectBrain implements BrainApi {
  private readonly base: string;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DirectBrainOptions) {
    this.base = opts.supabaseUrl.replace(/\/+$/, '') + '/rest/v1';
    this.dispatcher = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : undefined;
    this.timeoutMs = opts.timeoutMs ?? 2500;
  }

  private async req(method: string, path: string, body?: unknown, prefer?: string, extra?: Record<string, string>): Promise<{ status: number; json: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      apikey: this.opts.apiKey,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
      ...(extra ?? {}),
    };
    let res;
    try {
      res = await undiciFetch(this.base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        dispatcher: this.dispatcher,
      });
    } catch (err) {
      const name = err && typeof err === 'object' ? (err as { name?: string }).name : '';
      throw new BrainError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', null);
    }
    const text = await res.text();
    if (res.status >= 400) throw new BrainError('http', res.status); // body never surfaced: it can echo input
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new BrainError('shape', res.status);
      }
    }
    return { status: res.status, json, headers: res.headers as unknown as Headers };
  }

  private rows<T>(json: unknown, schema: z.ZodType<T>): T[] {
    const arr = z.array(z.unknown()).safeParse(json);
    if (!arr.success) throw new BrainError('shape', null);
    return arr.data.map((r) => {
      const p = schema.safeParse(r);
      if (!p.success) throw new BrainError('shape', null);
      return p.data;
    });
  }

  async ping(): Promise<void> {
    await this.req('GET', '/agent_comms?select=id&limit=1');
  }

  async insertFireRow(row: NewFireRow): Promise<FireRow> {
    const { json } = await this.req(
      'POST',
      '/agent_comms?select=*',
      {
        to_agent: row.toAgent,
        from_agent: row.fromAgent,
        from_harness: HARNESS_RELAY,
        to_harness: row.toHarness,
        channel: CHANNEL_SLACK,
        subject: row.subject,
        body: row.body,
        status: 'queued',
        fired_at: row.firedAt,
        evidence: { relay: row.evidence },
        code: CODE_FIRE,
      },
      'return=representation',
    );
    const out = this.rows(json, FireRowSchema)[0];
    if (!out) throw new BrainError('shape', null);
    return out;
  }

  async getFireRow(id: string): Promise<FireRow | null> {
    const { json } = await this.req('GET', `/agent_comms?select=*&id=eq.${encodeURIComponent(id)}&code=eq.${CODE_FIRE}`);
    return this.rows(json, FireRowSchema)[0] ?? null;
  }

  async listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]> {
    const st = statuses.map(encodeURIComponent).join(',');
    const { json } = await this.req(
      'GET',
      `/agent_comms?select=*&code=eq.${CODE_FIRE}&to_agent=eq.${encodeURIComponent(toAgent)}&status=in.(${st})&order=created_at.asc&limit=500`,
    );
    return this.rows(json, FireRowSchema);
  }

  async findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null> {
    const { json } = await this.req(
      'GET',
      `/agent_comms?select=*&code=eq.${CODE_FIRE}&to_agent=eq.${encodeURIComponent(toAgent)}&evidence->relay->>idem_key=eq.${encodeURIComponent(idemKey)}&limit=1`,
    );
    return this.rows(json, FireRowSchema)[0] ?? null;
  }

  async patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null> {
    let q = `/agent_comms?select=*&id=eq.${encodeURIComponent(id)}&code=eq.${CODE_FIRE}`;
    if (guard?.statusIn) q += `&status=in.(${guard.statusIn.map(encodeURIComponent).join(',')})`;
    if (guard?.version !== undefined) q += `&evidence->relay->>v=eq.${guard.version}`;
    const body: Record<string, unknown> = {};
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.completed_at !== undefined) body.completed_at = patch.completed_at;
    if (patch.evidence !== undefined) body.evidence = { relay: patch.evidence };
    const { json } = await this.req('PATCH', q, body, 'return=representation');
    return this.rows(json, FireRowSchema)[0] ?? null;
  }

  async countStarts(sinceIso: string, toAgent?: string): Promise<number> {
    let q = `/agent_comms?select=id&code=eq.${CODE_FIRE}&fired_at=gte.${encodeURIComponent(sinceIso)}&status=not.in.(refused,cancelled)`;
    if (toAgent) q += `&to_agent=eq.${encodeURIComponent(toAgent)}`;
    const { headers } = await this.req('GET', q, undefined, 'count=exact', { Range: '0-0', 'Range-Unit': 'items' });
    const cr = headers.get('content-range') ?? '';
    const total = Number(cr.split('/')[1]);
    if (!Number.isFinite(total)) throw new BrainError('shape', null);
    return total;
  }

  async insertAlertRow(toAgent: string, fromAgent: string, subject: string, body: string): Promise<void> {
    await this.req(
      'POST',
      '/agent_comms',
      {
        to_agent: toAgent,
        from_agent: fromAgent,
        from_harness: HARNESS_RELAY,
        channel: CHANNEL_SLACK,
        subject,
        body,
        status: 'queued',
        fired_at: new Date().toISOString(),
        code: CODE_ALERT,
      },
      'return=minimal',
    );
  }

  async getLease(name: string): Promise<LeaseRow | null> {
    const { json } = await this.req('GET', `/cto_relay_lease?select=*&name=eq.${encodeURIComponent(name)}`);
    return this.rows(json, LeaseRowSchema)[0] ?? null;
  }

  async insertLease(row: LeaseRow): Promise<LeaseRow | null> {
    const { json } = await this.req('POST', '/cto_relay_lease?select=*', row, 'resolution=ignore-duplicates,return=representation');
    return this.rows(json, LeaseRowSchema)[0] ?? null;
  }

  async casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null> {
    const { json } = await this.req(
      'PATCH',
      `/cto_relay_lease?select=*&name=eq.${encodeURIComponent(name)}&epoch=eq.${expectEpoch}`,
      { epoch: next.epoch, holder: next.holder, acquired_at: next.acquired_at, heartbeat_at: next.heartbeat_at, expires_at: next.expires_at },
      'return=representation',
    );
    return this.rows(json, LeaseRowSchema)[0] ?? null;
  }

  async renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null> {
    const { json } = await this.req(
      'PATCH',
      `/cto_relay_lease?select=*&name=eq.${encodeURIComponent(name)}&epoch=eq.${epoch}`,
      { heartbeat_at: heartbeatAt, expires_at: expiresAt },
      'return=representation',
    );
    return this.rows(json, LeaseRowSchema)[0] ?? null;
  }

  async upsertHeartbeat(agent: string, at: string): Promise<void> {
    await this.req('POST', '/cto_heartbeat?on_conflict=agent', { agent, heartbeat_at: at }, 'resolution=merge-duplicates,return=minimal');
  }

  async getHeartbeat(agent: string): Promise<HeartbeatRow | null> {
    const { json } = await this.req('GET', `/cto_heartbeat?select=*&agent=eq.${encodeURIComponent(agent)}`);
    return this.rows(json, HeartbeatRowSchema)[0] ?? null;
  }
}
