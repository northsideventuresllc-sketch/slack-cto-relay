// The poster (D2/D6): the ONLY path to Slack for this CTO's bot.
// - Fenced by the lease: a stale or lapsed epoch may not post.
// - Post-queue text (CTO words): plain names → real mentions, start pattern
//   stripped, then the blocklist — a hit BLOCKS the post (logged, never posted).
// - Relay templates: never carry the start pattern (asserted); any task text
//   embedded in a template is made safe first (redacted, mentions and `fire:`
//   neutralized) so a short reply can never trigger another start.
// - Backoff 1s/2s/4s/8s, Slack 429 uses Slack's delay, then a visible failure + alert.

import type { Blocklist } from './blocklist.js';
import { containsStartPattern, stripStartPattern, toRealMentions } from './blocklist.js';
import type { CtoEntry } from './config.js';
import type { LeaseManager } from './lease.js';
import type { RunLog } from './runlog.js';
import { withBackoff, type Sleep, realSleep } from './util/backoff.js';
import { sha256 } from './util/hash.js';
import { errorCode, type Logger } from './util/log.js';

export interface SlackSender {
  postWithTs(channel: string, text: string): Promise<string>;
  permalink(channel: string, ts: string): Promise<string>;
}

export type PostKind = 'template' | 'cto-words';

export type PostResult =
  | { ok: true; ts: string }
  | { ok: false; reason: 'stale-epoch' | 'blocked' | 'send-failed' | 'empty' };

export class Poster {
  private readonly sleep: Sleep;

  constructor(
    private readonly sender: SlackSender,
    private readonly lease: LeaseManager,
    private readonly blocklist: Blocklist,
    private readonly ctos: CtoEntry[],
    private readonly runlog: RunLog,
    private readonly log: Logger,
    private readonly onAlert: (code: string, ids?: Record<string, string | number | null>) => void,
    private readonly onCtoWords?: (channelId: string, ts: string) => void,
    sleep?: Sleep,
  ) {
    this.sleep = sleep ?? realSleep;
  }

  /**
   * Make task text safe to embed in a relay template: redact blocklist hits,
   * turn real mentions into plain names (no "@"), and neutralize "fire:".
   */
  safeTask(task: string): string {
    let t = this.blocklist.redact(task);
    for (const c of this.ctos) {
      t = t.replace(new RegExp(`<@${c.botUserId}(?:\\|[^>]*)?>`, 'g'), c.displayName);
      t = t.split(`@${c.displayName}`).join(c.displayName);
    }
    t = t.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, '$1').replace(/<!(?:channel|here|everyone)[^>]*>/g, '').replace(/fire:/gi, 'fire');
    return t;
  }

  async post(channelId: string, text: string, kind: PostKind, fireId: string | null = null): Promise<PostResult> {
    if (!this.lease.canAct()) {
      this.log.error('post refused: stale or lapsed epoch', { fireId, channelId });
      this.runlog.write({ kind: 'post', fireId, channelId, result: 'refused-stale-epoch', writer: 'relay' });
      return { ok: false, reason: 'stale-epoch' };
    }
    let out = text;
    if (kind === 'cto-words') {
      out = stripStartPattern(toRealMentions(text, this.ctos), this.ctos);
      const hits = this.blocklist.check(out);
      if (hits.length > 0) {
        this.log.warn('post blocked by blocklist', { fireId, channelId, rules: hits.map((h) => `${h.rule}#${h.index}`).join(','), textHash: sha256(text) });
        this.runlog.write({ kind: 'post', fireId, channelId, result: 'blocked', reason: hits[0]?.rule ?? 'blocked', writer: 'relay' });
        this.runlog.audit({ fireId, action: 'post-blocked', snippet: this.blocklist.snippet(out) });
        this.onAlert('post-blocked', { fireId, textHash: sha256(text) });
        return { ok: false, reason: 'blocked' };
      }
    } else if (containsStartPattern(out, this.ctos)) {
      // Must never happen: relay templates never carry the start pattern. Strip, and say so loudly.
      this.log.error('template carried the start pattern; stripped', { fireId });
      out = stripStartPattern(out, this.ctos);
    }
    if (out.trim().length === 0) return { ok: false, reason: 'empty' };
    try {
      const ts = await withBackoff(() => this.sender.postWithTs(channelId, out), this.sleep);
      this.runlog.write({ kind: 'post', fireId, channelId, ts, result: 'posted', writer: 'relay' });
      if (kind === 'cto-words') this.onCtoWords?.(channelId, ts);
      return { ok: true, ts };
    } catch (err) {
      const code = errorCode(err);
      this.log.error('post failed after backoff', { fireId, channelId, err: code });
      this.runlog.write({ kind: 'post', fireId, channelId, result: 'failed', reason: code.slice(0, 60), writer: 'relay' });
      this.onAlert(/invalid_auth|token_revoked|account_inactive|not_authed/.test(code) ? 'token-revoked' : 'post-failed', { fireId, channelId });
      return { ok: false, reason: 'send-failed' };
    }
  }

  async permalink(channelId: string, ts: string): Promise<string> {
    return withBackoff(() => this.sender.permalink(channelId, ts), this.sleep);
  }
}
