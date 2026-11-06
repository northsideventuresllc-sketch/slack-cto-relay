// The fire parser (D4 + D6 "Parsing"). Pure functions: no I/O.
// Only app_mention events and slash commands ever reach parseStart() — the
// single-parser rule is enforced by the router, and asserted here.

import type { CtoEntry, Registry } from './config.js';
import type { SlackEvent } from './contracts.js';

export const MAX_TASK_CHARS = 280;
export const MAX_EVENT_BYTES = 10 * 1024;

export const REPLY_EMPTY = 'Say what the task is.';
export const REPLY_TOO_LONG = 'Too long. Keep it under 280 characters.';
export const REPLY_MULTI = 'Start one CTO at a time.';
export const REPLY_NOT_FIRE_COMMAND = 'I only take /fire commands here.';

export type ParseResult =
  | { kind: 'start'; task: string }
  | { kind: 'reply'; text: string; reason: 'empty' | 'too-long' | 'multi-mention' | 'not-fire-command' }
  | { kind: 'ignore'; reason: string };

/** Slack escapes &, <, > in message text. */
export function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Strip code blocks (fenced and single-backtick) and quote lines before
 * matching (D6). Works on Slack-escaped text: quote lines start with "&gt;".
 */
export function stripCodeAndQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(?:&gt;|>)/.test(line))
    .join('\n');
}

const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

function mentionedCtoIds(text: string, ctos: CtoEntry[]): string[] {
  const ids = new Set(ctos.map((c) => c.botUserId));
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[1];
    if (id && ids.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function validateTask(raw: string): ParseResult {
  const task = unescapeSlack(raw).replace(/\s+/g, ' ').trim();
  if (task.length === 0) return { kind: 'reply', text: REPLY_EMPTY, reason: 'empty' };
  if ([...task].length > MAX_TASK_CHARS) return { kind: 'reply', text: REPLY_TOO_LONG, reason: 'too-long' };
  return { kind: 'start', task };
}

/**
 * Parse a start request for THIS CTO's program.
 * - slash_command: must be this CTO's /fire command; any other command gets the fixed reply.
 * - app_mention: must carry `<@this bot> fire: <task>` after stripping code and quotes.
 *   A bare mention never starts work. Multiple CTO mentions with the start
 *   pattern get "Start one CTO at a time." — only from the first-mentioned
 *   CTO's program, so exactly one reply goes out.
 */
export function parseStart(ev: SlackEvent, me: CtoEntry, registry: Registry): ParseResult {
  if (ev.ingress === 'message' || ev.ingress === undefined) {
    // Single-parser rule: a `message` event never feeds the fire parser.
    return { kind: 'ignore', reason: 'message-event-never-parsed' };
  }
  if (ev.edited) return { kind: 'ignore', reason: 'edit-never-refires' };
  if (Buffer.byteLength(ev.text, 'utf8') > MAX_EVENT_BYTES) return { kind: 'ignore', reason: 'too-large' };

  if (ev.ingress === 'slash_command') {
    if (ev.command !== me.command) {
      return { kind: 'reply', text: REPLY_NOT_FIRE_COMMAND, reason: 'not-fire-command' };
    }
    return validateTask(ev.text);
  }

  // app_mention
  const cleaned = stripCodeAndQuotes(ev.text);
  const startRe = /<@([A-Z0-9]+)(?:\|[^>]*)?>\s*fire:/i;
  if (!startRe.test(cleaned)) return { kind: 'ignore', reason: 'no-start-pattern' };

  const mentioned = mentionedCtoIds(cleaned, registry.ctos);
  if (mentioned.length > 1) {
    if (mentioned[0] === me.botUserId) return { kind: 'reply', text: REPLY_MULTI, reason: 'multi-mention' };
    return { kind: 'ignore', reason: 'multi-mention-other-replies' };
  }

  const mine = new RegExp(`<@${me.botUserId}(?:\\|[^>]*)?>\\s*fire:([\\s\\S]*)$`, 'i');
  const m = mine.exec(cleaned);
  if (!m) return { kind: 'ignore', reason: 'start-pattern-not-for-me' };
  return validateTask(m[1] ?? '');
}

/** "abort: <fire id>" (D4). Returns the quoted id, or null. Accepts a full id or a unique prefix of ≥8 hex chars. */
export function parseAbort(text: string): string | null {
  const cleaned = stripCodeAndQuotes(text).trim();
  const m = /^abort:\s*([0-9a-f][0-9a-f-]{7,35})\s*$/i.exec(cleaned);
  return m?.[1]?.toLowerCase() ?? null;
}
