// slack-transport (D6 layer 1): the Slack ChannelAdapter over Socket Mode.
// - Every envelope is acked on receipt (well inside Slack's 3-second window);
//   the short reply is posted by the router right after.
// - Socket Mode disconnect: reconnect with backoff 1s/2s/4s/8s/16s, max 5
//   attempts, then the program stays down and alerts Muse CTO (D6).
// - Unknown fields are ignored (Zod strips them); malformed events are dropped
//   and logged by id only.

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, LogLevel } from '@slack/web-api';
import { ProxyAgent } from 'undici';
import { z } from 'zod';
import type { ChannelAdapter, ChannelEvent, SlackEvent } from '../contracts.js';
import { SOCKET_RECONNECT_BACKOFF_MS, realSleep, type Sleep } from '../util/backoff.js';
import type { Logger } from '../util/log.js';

const InnerEventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  bot_profile: z.object({ user_id: z.string().optional() }).optional(),
  text: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  event_ts: z.string().optional(),
  thread_ts: z.string().optional(),
  edited: z.unknown().optional(),
});

const EventsApiBodySchema = z.object({
  event_id: z.string().optional(),
  event: InnerEventSchema,
});

const SlashBodySchema = z.object({
  command: z.string(),
  text: z.string().default(''),
  user_id: z.string(),
  channel_id: z.string(),
  trigger_id: z.string().optional(),
});

/** Exit code that tells systemd not to restart (RestartPreventExitStatus): "the program stays down". */
export const EXIT_STAY_DOWN = 78;

export interface SlackChannelOptions {
  appToken: string;
  botToken: string;
  httpsProxy?: string | null;
  log: Logger;
  sleep?: Sleep;
  onFatal: (code: 'socket-reconnect-exhausted' | 'token-revoked') => void;
}

/** Async queue: socket callbacks push, listen() pulls. */
class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
  }
  async *iterate(): AsyncIterable<T> {
    while (true) {
      const v = this.items.shift();
      if (v !== undefined) {
        yield v;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((r) => this.waiters.push(r));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class SlackChannel implements ChannelAdapter {
  readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly queue = new EventQueue<SlackEvent>();
  private stopping = false;
  private reconnecting = false;
  private readonly sleep: Sleep;

  constructor(private readonly opts: SlackChannelOptions) {
    this.sleep = opts.sleep ?? realSleep;
    const dispatcher = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : undefined;
    // Our own backoff owns retries (D6): the client's built-in retries are off and 429s are surfaced.
    this.web = new WebClient(opts.botToken, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      logLevel: LogLevel.ERROR,
      timeout: 10_000,
      ...(dispatcher ? { fetch: ((input: unknown, init?: Record<string, unknown>) => import('undici').then((u) => u.fetch(input as never, { ...(init ?? {}), dispatcher } as never))) as never } : {}),
    });
    this.socket = new SocketModeClient({
      appToken: opts.appToken,
      autoReconnectEnabled: false,
      logLevel: LogLevel.ERROR,
      clientOptions: { retryConfig: { retries: 0 } },
      ...(dispatcher ? { dispatcher } : {}),
    });
    this.socket.on('slack_event', (args: { ack: (r?: unknown) => Promise<void>; type: string; body: unknown; retry_num?: number }) => {
      void args.ack().catch(() => this.opts.log.warn('ack failed'));
      this.ingest(args.type, args.body, args.retry_num);
    });
    this.socket.on('disconnected', () => {
      if (!this.stopping) void this.reconnect();
    });
  }

  async start(): Promise<void> {
    await this.socket.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.queue.close();
    await this.socket.disconnect().catch(() => undefined);
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (let i = 0; i < SOCKET_RECONNECT_BACKOFF_MS.length; i++) {
      await this.sleep(SOCKET_RECONNECT_BACKOFF_MS[i] ?? 16000);
      if (this.stopping) break;
      try {
        await this.socket.start();
        this.reconnecting = false;
        this.opts.log.info('socket reconnected', { attempt: i + 1 });
        return;
      } catch (err) {
        this.opts.log.warn('socket reconnect failed', { attempt: i + 1, err });
      }
    }
    this.reconnecting = false;
    if (!this.stopping) this.opts.onFatal('socket-reconnect-exhausted');
  }

  /** Normalize a raw Socket Mode payload into a SlackEvent, or drop it (logged by id only). */
  ingest(type: string, body: unknown, retryNum?: number): void {
    try {
      const ev = normalizeSlackPayload(type, body, retryNum);
      if (ev) this.queue.push(ev);
    } catch {
      this.opts.log.warn('malformed event dropped', { type });
    }
  }

  async post(channel: string, text: string): Promise<void> {
    await this.postWithTs(channel, text);
  }

  /** EXTENSION: post and return the message ts (needed for the map permalink). */
  async postWithTs(channel: string, text: string): Promise<string> {
    const res = await this.web.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
    if (!res.ts) throw Object.assign(new Error('no ts'), { code: 'slack_no_ts' });
    return res.ts;
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const res = await this.web.chat.getPermalink({ channel, message_ts: ts });
    if (!res.permalink) throw Object.assign(new Error('no permalink'), { code: 'slack_no_permalink' });
    return res.permalink;
  }

  /** Recent messages in a channel (still-active test prong (b); failover dedup read-back). */
  async history(channel: string, oldestTs: string): Promise<Array<{ user: string | null; text: string; ts: string }>> {
    const res = await this.web.conversations.history({ channel, oldest: oldestTs, limit: 200 });
    return (res.messages ?? []).map((m) => ({ user: m.user ?? m.bot_profile?.user_id ?? null, text: m.text ?? '', ts: m.ts ?? '' }));
  }

  /** Token check at start: an invalid or revoked token fails closed for this CTO only. */
  async authTest(): Promise<{ userId: string }> {
    const res = await this.web.auth.test();
    if (!res.user_id) throw Object.assign(new Error('auth.test returned no user'), { code: 'slack_auth' });
    return { userId: res.user_id };
  }

  listen(): AsyncIterable<ChannelEvent> {
    return this.queue.iterate();
  }

  /** Same stream, typed with the Slack extensions. */
  listenSlack(): AsyncIterable<SlackEvent> {
    return this.queue.iterate();
  }
}

export function normalizeSlackPayload(type: string, body: unknown, retryNum?: number): SlackEvent | null {
  if (type === 'events_api') {
    const b = EventsApiBodySchema.parse(body);
    const e = b.event;
    if (e.type !== 'app_mention' && e.type !== 'message') return null;
    // Edits and deletes arrive as message subtypes: edits never re-fire.
    const edited = e.subtype === 'message_changed' || e.edited !== undefined;
    if (e.subtype === 'message_deleted' || e.subtype === 'channel_join' || e.subtype === 'channel_leave') return null;
    const authorId = e.user ?? e.bot_profile?.user_id ?? e.bot_id ?? '';
    if (!e.channel || !authorId) return null;
    return {
      eventId: b.event_id ?? '',
      channelId: e.channel,
      authorId,
      text: e.text ?? '',
      timestamp: e.ts ?? e.event_ts ?? '',
      ingress: e.type === 'app_mention' ? 'app_mention' : 'message',
      triggerId: null,
      command: null,
      edited,
      threadTs: e.thread_ts ?? null,
      retryNum: retryNum ?? 0,
    };
  }
  if (type === 'slash_commands') {
    const s = SlashBodySchema.parse(body);
    return {
      eventId: '',
      channelId: s.channel_id,
      authorId: s.user_id,
      text: s.text,
      timestamp: String(Date.now() / 1000),
      ingress: 'slash_command',
      triggerId: s.trigger_id ?? null,
      command: s.command,
      edited: false,
      threadTs: null,
      retryNum: 0,
    };
  }
  return null;
}
