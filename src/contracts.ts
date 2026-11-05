// Contracts — the single definitions from PLAN-v7.md "Contracts".
// HarnessAdapter v1 and ChannelAdapter are defined here and nowhere else.
// Extensions beyond the plan text are marked "EXTENSION" and only ADD optional
// fields; they never change a field the plan defines.

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

/** A channel event, in channel-agnostic form. Every channel adapter produces these. */
export interface ChannelEvent {
  eventId: string; // the channel's own event id, for dedup
  channelId: string; // the channel the event arrived in
  authorId: string; // the bot or human who wrote it
  text: string; // the message text
  timestamp: string; // the channel's timestamp, for ordering
}

/**
 * EXTENSION: how the event reached the relay. The single-parser rule (D2)
 * routes on this: only `app_mention` and `slash_command` ever reach the fire
 * parser; `message` feeds only the post path (activity + abort + mirror).
 */
export type IngressKind = 'app_mention' | 'message' | 'slash_command';

/**
 * Slack's implementation of a channel event: the Slack event id, the Slack
 * channel id, the Slack user id, the Slack message text, the Slack ts.
 */
export interface SlackEvent extends ChannelEvent {
  // EXTENSION fields (optional on the wire, always set by the Slack adapter):
  ingress?: IngressKind;
  triggerId?: string | null; // slash commands: Slack trigger id (dedup fallback 1)
  command?: string | null; // slash commands: e.g. "/fire-claude"
  edited?: boolean; // edits never re-fire (D6 parsing)
  threadTs?: string | null; // thread replies are treated as channel messages
  retryNum?: number; // Slack delivery retry count
}

export interface ChannelAdapter {
  post(channel: string, text: string): Promise<void>;
  listen(): AsyncIterable<ChannelEvent>;
}

// ---------------------------------------------------------------------------
// Journal records
// ---------------------------------------------------------------------------

/** The journal is append-only. Every record is one line, newline-delimited JSON. */
export type JournalRecordKind = 'fire-request' | 'fire-state' | 'breaker-count';

export interface JournalRecord {
  kind: JournalRecordKind;
  fireId: string; // the brain-row id (also the fire id quoted in the short reply)
  hash: string; // SHA-256 of the task text (fire-request) or of the normalized task (breaker-count)
  timestamp: string; // journal write time — the one timestamp used for abort-vs-claim comparisons
  // kind-specific fields:
  //   fire-state: claimName (who claimed it)
  //   breaker-count: windowStart (the 10-minute window this attempt belongs to)
  claimName?: string;
  windowStart?: string;
  // EXTENSION fields — ids and hashes only, never task text (D6 redaction):
  cto?: string; // CTO key (muse | claude | gemini | axon-hermes)
  state?: FireJournalState; // fire-state: the state this record moves the fire to
  channelId?: string; // fire-request: where the requester is watching
  normHash?: string; // fire-request: SHA-256 of the normalized task (task dedup)
  idemKey?: string; // fire-request: SHA-256 idempotency key (CTO + normalized task + minute bucket)
  eventKey?: string; // fire-request: SHA-256 event dedup key
  provisional?: boolean; // fire-request: brain was down; fireId is a local id until the brain write lands
  brainId?: string; // fire-state 'brain-written': the brain-row id a provisional fire id maps to
  closeoutKey?: string; // fire-state 'closed': close-out key (kept 90 days)
  reason?: string; // short machine reason code (no free text)
}

/** EXTENSION: the states a `fire-state` record can carry. */
export type FireJournalState =
  | 'brain-written'
  | 'claimed'
  | 'started'
  | 'linked'
  | 'done'
  | 'closed'
  | 'failed'
  | 'expired'
  | 'refused'
  | 'cancelled'
  | 'abort-requested'
  | 'stop-requested'
  | 'lock-cleared'
  | 'overrun'
  | 'review-cleared'
  | 'reply-posted'
  | 'link-posted'
  | 'lost-notified'
  | 'closeout-requested'
  | 'retry-pending'
  | 'retry-done';

// ---------------------------------------------------------------------------
// Harness adapter — HarnessAdapter v1
// ---------------------------------------------------------------------------

export type FireStatus = 'started-automatically' | 'queued-for-person' | 'already-running' | 'refused';

/**
 * The state a run is in, as reported by status(). For manual adapters the
 * states are the handoff record states: queued, claimed, started, linked,
 * done, closed, failed, expired, refused, cancelled.
 */
export type RunState =
  | FireStatus
  | 'queued'
  | 'claimed'
  | 'started'
  | 'linked'
  | 'done'
  | 'closed'
  | 'failed'
  | 'expired'
  | 'refused'
  | 'cancelled';

/** One health answer, used by health() and by HealthResponse.adapter alike. */
export interface AdapterHealth {
  reachable: boolean;
  detail: string; // queue depth + last claim time for manual adapters
}

export interface HealthResponse {
  fireLatencyMsP50: number | null; // fire -> run id; null before the first fire
  linkLatencyMsP50: number | null; // fire -> link
  manualQueueLatencyMs: number | null; // manual adapters: fire -> claim; null until the first claim
  ackBreachCount: number;
  adapter: AdapterHealth;
  // R7-FU-2: the two fields D6 says the health endpoint returns.
  queueDepth: number; // non-terminal entries in this CTO's queue (max 10)
  leaseState: 'none' | 'held' | 'lapsed' | 'lost'; // this program's brain lease state
}

export interface FireRequest {
  task: string; // the task text, at most 280 characters
  epoch: number; // the lease fencing token; checked against cto_relay_lease before firing
  meta?: FireMeta; // EXTENSION: routing context the adapter writes into the brain row
}

/** EXTENSION: ids and hashes the adapter records with the brain row (no extra task text). */
export interface FireMeta {
  taskHash: string;
  normHash: string;
  idemKey: string;
  fromAgent: string; // agent name of the requesting CTO bot
  channelId: string;
  messageTs: string | null;
  permalink: string | null;
}

export interface HarnessAdapter {
  /**
   * EXTENSION (KAR-6): true only if status() is a real live probe of the run in
   * its harness. false = status() reads stored state (the brain row), so the
   * still-active test's prong (a) does not apply to this adapter. Every v1
   * adapter is false.
   */
  readonly liveStatus?: boolean;
  fire(req: FireRequest): Promise<{ runId: string; runChatUrl: string | null; status: FireStatus }>;
  status(runId: string): Promise<{ state: RunState; runChatUrl: string | null }>;
  cancel(runId: string): Promise<void>; // marks the run cancelled; for Muse, the brain row status becomes 'cancelled' and the drain skips it; for manual, the handoff record becomes 'cancelled'
  health(): Promise<AdapterHealth>;
}

/** Terminal run states: a run in one of these no longer holds the already-running lock. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'closed',
  'failed',
  'expired',
  'refused',
  'cancelled',
]);

/**
 * Non-terminal brain-row states read on restore/failover. R2-NEW-1 names
 * `queued`, `claimed`, `started`; `linked` is also non-terminal (the run is
 * live until `closed`), so it is read too — a strict superset, never fewer.
 */
export const NON_TERMINAL_ROW_STATES = ['queued', 'claimed', 'started', 'linked'] as const;
