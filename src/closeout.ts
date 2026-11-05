// D5 — Close-out: the map to the log. The relay is the sole poster of maps.
// 1. The CTO files a structured session log in the vault with a .sha256 sidecar.
// 2. The relay reads the vault path back live, hashes the bytes, compares to the sidecar.
// 3. Only on a match: the full map in the CTO's own channel, then a one-line
//    pointer in #cto-bots tagging all four. The pointer is the sole link to the map.
// 5. No read-back → nothing claiming completion is posted; the map waits in the
//    durable outbox (5 min × 12, hourly × 24, TTL 7 days) and Muse CTO is alerted.

import type { RelayCore } from './core.js';
import type { CostEnvelope } from './caps.js';
import type { Outbox, OutboxEntry } from './outbox.js';
import { T, clampWords } from './templates.js';
import { parseSessionLog, safeVaultPath, type VaultReader } from './vault.js';
import { sha256 } from './util/hash.js';
import type { Serialize } from './maintenance.js';
import type { ReadBack } from './vault.js';
import { iso } from './util/time.js';

export interface CloseoutRequest {
  fireId: string;
  vaultLogPath: string;
  sessionUrl: string | null; // run-chat link in the D4 per-CTO form; falls back to the posted run link
  tokens: number | null; // null = unmetered (D4 cost envelope)
  minutes: number | null;
}

export class Closeouts {
  constructor(
    private readonly core: RelayCore,
    private readonly outbox: Outbox,
    private readonly vault: VaultReader,
    private readonly caps: CostEnvelope,
    /** The event lane. The slow vault read-back runs OUTSIDE it; posting and recording run inside it. */
    private readonly serialize: Serialize = (fn) => fn(),
  ) {}

  /** Request + first attempt (the read-back runs outside the lane). */
  async submit(req: CloseoutRequest): Promise<{ ok: boolean; reason: string }> {
    const r = await this.serialize(() => this.request(req));
    if (!r.entry) return { ok: r.ok, reason: r.reason };
    return (await this.attempt(r.entry)) ? { ok: true, reason: 'posted' } : { ok: true, reason: 'queued-in-outbox' };
  }

  /** Muse CTO hands in a close-out (control socket). Validates and queues it durably; call attempt() next, outside the lane. */
  async request(req: CloseoutRequest): Promise<{ ok: boolean; reason: string; entry?: OutboxEntry }> {
    const d = this.core.d;
    const e = d.book.resolveQuoted(req.fireId);
    if (!e || e.provisional) return { ok: false, reason: 'unknown-fire' };
    if (e.terminal) return { ok: false, reason: 'already-terminal' };
    if (!safeVaultPath(req.vaultLogPath)) return { ok: false, reason: 'bad-vault-path' };
    const row = await d.brain.getFireRow(e.id).catch(() => null);
    const session = req.sessionUrl ?? (row ? ((row.evidence as { relay?: { run_chat_url?: string | null } })?.relay?.run_chat_url ?? null) : null);
    // No map ever carries a null or placeholder link.
    if (!session) return { ok: false, reason: 'no-session-link' };
    if (d.blocklist.check(session).length > 0) return { ok: false, reason: 'session-link-blocked' };
    const now = d.clock();
    this.core.record({ kind: 'fire-state', fireId: e.id, hash: '', state: 'closeout-requested' });
    await this.core
      .updateEvidence(e.id, (ev) => ({
        ...ev,
        closeout: { requested_at: iso(now), vault_log_path: req.vaultLogPath, session_url: session, tokens: req.tokens, minutes: req.minutes, still_open: null, map_permalink: null },
      }))
      .catch(() => null);
    const entry: OutboxEntry = {
      fireId: e.id,
      vaultLogPath: req.vaultLogPath,
      sessionUrl: session,
      tokens: req.tokens,
      minutes: req.minutes,
      createdAt: iso(now),
      attempts: 0,
      nextAttemptAt: iso(now),
      step: 'readback',
      logHash: null,
      mapTs: null,
      mapPermalink: null,
      done: null,
      stillOpen: null,
    };
    this.outbox.put(entry);
    return { ok: true, reason: 'queued', entry };
  }

  /** Drain due outbox entries (scheduler, every minute). */
  async drain(): Promise<void> {
    const now = this.core.d.clock();
    const entries = this.outbox.list();
    for (const fireId of this.outbox.corruptOnLoad) await this.serialize(() => this.rebuild(fireId));
    for (const e of entries) if (Date.parse(e.nextAttemptAt) <= now) await this.attempt(e);
  }

  /** Rebuild a corrupt outbox entry from the journal (closeout-requested) + the brain row's close-out request. */
  async rebuild(fileId: string): Promise<void> {
    const d = this.core.d;
    const e = d.book.all().find((x) => x.id.replace(/[^A-Za-z0-9-]/g, '_') === fileId);
    if (!e || e.terminal) return;
    const requested = d.journal.historyOf(e.id).some((r) => r.state === 'closeout-requested');
    if (!requested) return;
    const row = await d.brain.getFireRow(e.id).catch(() => null);
    const co = (row?.evidence as { relay?: { closeout?: { vault_log_path: string; session_url: string | null; tokens: number | null; minutes: number | null; requested_at: string } } })?.relay?.closeout;
    if (!co || !co.session_url) {
      d.alert('outbox-rebuild-failed', { fireId: e.id });
      return;
    }
    const now = iso(d.clock());
    this.outbox.put({
      fireId: e.id,
      vaultLogPath: co.vault_log_path,
      sessionUrl: co.session_url,
      tokens: co.tokens,
      minutes: co.minutes,
      createdAt: co.requested_at,
      attempts: 0,
      nextAttemptAt: now,
      step: 'readback',
      logHash: null,
      mapTs: null,
      mapPermalink: null,
      done: null,
      stillOpen: null,
    });
    d.alert('outbox-rebuilt', { fireId: e.id });
  }

  /** One attempt. Returns true when the map and the pointer are both posted. */
  async attempt(entry: OutboxEntry): Promise<boolean> {
    // Slow part first, outside the lane: fetch the vault and read the log back.
    const rb: ReadBack | null = entry.step === 'readback' ? await this.vault.readBack(entry.vaultLogPath) : null;
    return this.serialize(() => this.postAndFinish(entry, rb));
  }

  private async postAndFinish(entry: OutboxEntry, rb: ReadBack | null): Promise<boolean> {
    const d = this.core.d;
    const fire = d.book.get(entry.fireId);
    if (!fire || fire.terminal) {
      this.outbox.remove(entry.fireId);
      return false;
    }
    let cur = this.outbox.get(entry.fireId) ?? entry;
    if (cur.step === 'readback') {
      if (!rb || !rb.ok || !rb.bytes || !rb.hash) {
        d.log.warn('close-out read-back failed; map held in outbox', { fireId: cur.fireId, reason: rb?.reason ?? 'unknown' });
        if (cur.attempts === 0) d.alert('closeout-readback-failed', { fireId: cur.fireId, reason: rb?.reason ?? 'unknown' });
        const next = this.outbox.failAttempt(cur, d.clock());
        if (!next) d.alert('closeout-outbox-expired', { fireId: cur.fireId });
        return false;
      }
      const log = parseSessionLog(rb.bytes.toString('utf8'));
      const doneLine = clampWords(d.blocklist.redact(log.decided[0] ?? 'Run finished.'), 20);
      const stillOpen = log.openItems.length ? d.blocklist.redact(log.openItems.join('; ')) : 'None';
      const logUrl = this.vault.webUrl(cur.vaultLogPath);
      if (!logUrl) {
        d.alert('closeout-no-vault-web-base', { fireId: cur.fireId });
        this.outbox.failAttempt(cur, d.clock());
        return false;
      }
      const label = cur.vaultLogPath.split('/').pop()?.replace(/\.md$/, '') ?? 'session log';
      const map = T.map(doneLine, label, logUrl, cur.sessionUrl, stillOpen, d.registry.ctos);
      const posted = await d.poster.post(d.cto.channelId, map, 'template', cur.fireId);
      if (!posted.ok) {
        this.outbox.failAttempt(cur, d.clock());
        return false;
      }
      let permalink: string;
      try {
        permalink = await d.poster.permalink(d.cto.channelId, posted.ts);
      } catch {
        permalink = `https://${d.registry.workspace.domain}/archives/${d.cto.channelId}/p${posted.ts.replace('.', '')}`;
      }
      cur = { ...cur, step: 'pointer', logHash: rb.hash, mapTs: posted.ts, mapPermalink: permalink, done: doneLine, stillOpen };
      this.outbox.put(cur);
    }
    if (cur.step === 'pointer' && cur.mapPermalink && cur.done) {
      const ptr = await d.poster.post(d.registry.ctoBotsChannelId, T.pointer(cur.done, cur.mapPermalink, d.registry.ctos), 'template', cur.fireId);
      if (!ptr.ok) {
        this.outbox.failAttempt(cur, d.clock());
        return false;
      }
      this.finish(cur);
      return true;
    }
    return false;
  }

  private finish(cur: OutboxEntry): void {
    const d = this.core.d;
    const closeoutKey = sha256(`${cur.fireId}|${cur.vaultLogPath}|${cur.logHash ?? ''}`);
    this.core.record({ kind: 'fire-state', fireId: cur.fireId, hash: '', state: 'closed', closeoutKey });
    d.runlog.write({ kind: 'closeout', fireId: cur.fireId, writer: `adapter:${d.cto.key}`, state: 'closed' });
    const fire = d.book.get(cur.fireId);
    const started = fire?.startedAt ?? fire?.claimAt ?? fire?.acceptedAt ?? d.clock();
    const minutes = cur.minutes ?? Math.round((d.clock() - started) / 60_000);
    d.runlog.cost(cur.fireId, fire?.taskHash ?? '', d.cto.home, cur.tokens, minutes);
    if (this.caps.isOverrun(cur.tokens)) {
      this.core.record({ kind: 'fire-state', fireId: cur.fireId, hash: '', state: 'overrun', reason: 'token-budget' });
      d.alert('run-over-token-budget', { fireId: cur.fireId, tokens: cur.tokens });
    }
    const stillOpen = cur.stillOpen;
    const permalink = cur.mapPermalink;
    void this.core
      .updateEvidence(cur.fireId, (ev) => ({ ...ev, closeout: ev.closeout ? { ...ev.closeout, still_open: stillOpen, map_permalink: permalink } : ev.closeout }), {
        to: 'closed',
        from: ['queued', 'claimed', 'started', 'linked'],
        completed: true,
      })
      .catch(() => d.alert('closeout-brain-write-failed', { fireId: cur.fireId }));
    this.outbox.remove(cur.fireId);
  }
}
