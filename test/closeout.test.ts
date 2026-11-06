import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Closeouts } from '../src/closeout.js';
import { Outbox, nextAttemptDelay, FAST_RETRIES, SLOW_RETRIES } from '../src/outbox.js';
import { parseSessionLog, parseSidecar, safeVaultPath, type ReadBack, type VaultReader } from '../src/vault.js';
import { ctoEntry } from '../src/config.js';
import { sha256 } from '../src/util/hash.js';
import { MIN, HOUR } from '../src/util/time.js';
import { makeHarness, mention } from './helpers.js';

const LOG = '# Session\n\n## Decided\n- Match Fit email groups built and merged.\n\n## Why\n- asked\n\n## What failed\n- none\n\n## Reusable\n- template\n\n## Open items\n- Deploy check. Owner: Muse CTO.\n';

class FakeVault implements VaultReader {
  ok = true;
  async readBack(path: string): Promise<ReadBack> {
    if (!this.ok) return { ok: false, reason: 'log-missing' };
    const bytes = Buffer.from(LOG);
    return { ok: true, bytes, hash: sha256(bytes) };
  }
  webUrl(path: string): string {
    return `https://vault.invalid/blob/main/${encodeURIComponent(path)}`;
  }
}

async function linkedRun(cto: 'muse' | 'claude' = 'claude') {
  const h = await makeHarness(cto);
  await h.core.handleEvent(mention(h, cto, 'fire: build groups'));
  const id = h.brain.insertOrder[0]!;
  await h.core.claim(id, 'Muse CTO');
  await h.core.markStarted(id);
  await h.core.setLink(id, 'https://claude.ai/code/session-example');
  const vault = new FakeVault();
  const outbox = new Outbox(h.dir);
  const co = new Closeouts(h.core, outbox, vault, h.core.d.caps);
  return { h, id, vault, outbox, co };
}

test('close-out: read-back matches → full map in the CTO channel, then the pointer in #cto-bots; row closed; lock released', async () => {
  const { h, id, co } = await linkedRun('claude');
  const res = await co.submit({ fireId: id, vaultLogPath: 'Sector/Session Logs/2026-11-05-x.md', sessionUrl: null, tokens: 1200, minutes: 30 });
  assert.deepEqual(res, { ok: true, reason: 'posted' });
  const claude = ctoEntry(h.registry, 'claude');
  const map = h.sender.posts.at(-2)!;
  const ptr = h.sender.posts.at(-1)!;
  assert.equal(map.channel, claude.channelId);
  const lines = map.text.split('\n');
  assert.equal(lines[0], 'Done: Match Fit email groups built and merged.');
  assert.match(lines[1]!, /^Log: <https:\/\/vault\.invalid\/.+\|2026-11-05-x>$/);
  assert.equal(lines[2], 'Session: https://claude.ai/code/session-example');
  assert.equal(lines[3], 'Still open: Deploy check. Owner: Muse CTO.');
  for (const c of h.registry.ctos) assert.ok(map.text.includes(`<@${c.botUserId}>`), 'map tags all four');
  assert.equal(ptr.channel, h.registry.ctoBotsChannelId);
  assert.match(ptr.text, /^Close-out: Match Fit email groups built and merged\.\. Map is here: https:\/\/example\.invalid\/archives\//);
  assert.equal(h.brain.rows.get(id)?.status, 'closed');
  assert.equal(h.book.get(id)?.terminal, true);
  assert.ok(h.journal.all().some((r) => r.state === 'closed' && r.closeoutKey));
});

test('close-out: no read-back → nothing claiming completion is posted; the map waits in the outbox and Muse CTO is alerted', async () => {
  const { h, id, vault, outbox, co } = await linkedRun('claude');
  vault.ok = false;
  const before = h.sender.posts.length;
  const res = await co.submit({ fireId: id, vaultLogPath: 'x/log.md', sessionUrl: null, tokens: null, minutes: null });
  assert.deepEqual(res, { ok: true, reason: 'queued-in-outbox' });
  assert.equal(h.sender.posts.length, before);
  assert.ok(h.alerts.includes('closeout-readback-failed'));
  assert.equal(outbox.list().length, 1);
  // vault fixed; the 5-minute retry posts it
  vault.ok = true;
  await h.advance(5 * MIN);
  await co.drain();
  assert.equal(outbox.list().length, 0);
  assert.equal(h.brain.rows.get(id)?.status, 'closed');
});

test('close-out over the token budget: flagged, and the next start for that CTO is refused until the Monday review', async () => {
  const { h, id, co } = await linkedRun('claude');
  await co.submit({ fireId: id, vaultLogPath: 'x/log.md', sessionUrl: null, tokens: 30_000, minutes: 10 });
  await h.advance(31 * MIN);
  await h.core.handleEvent(mention(h, 'claude', 'fire: next'));
  assert.match(h.sender.texts().at(-1)!, /Starts resume after the Monday review/);
  h.core.reviewClear();
  await h.core.handleEvent(mention(h, 'claude', 'fire: next again'));
  assert.match(h.sender.texts().at(-1)!, /^Started: next again/);
});

test('close-out without any session link is refused (no map ever carries a null link)', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: x'));
  const co = new Closeouts(h.core, new Outbox(h.dir), new FakeVault(), h.core.d.caps);
  assert.deepEqual(await co.submit({ fireId: h.brain.insertOrder[0]!, vaultLogPath: 'a/b.md', sessionUrl: null, tokens: null, minutes: null }), { ok: false, reason: 'no-session-link' });
});

test('outbox schedule: 5 minutes × 12, then hourly × 24, then done', () => {
  assert.equal(nextAttemptDelay(0), 5 * MIN);
  assert.equal(nextAttemptDelay(FAST_RETRIES - 1), 5 * MIN);
  assert.equal(nextAttemptDelay(FAST_RETRIES), HOUR);
  assert.equal(nextAttemptDelay(FAST_RETRIES + SLOW_RETRIES - 1), HOUR);
  assert.equal(nextAttemptDelay(FAST_RETRIES + SLOW_RETRIES), null);
});

test('vault helpers: sidecar parsing, safe paths, structured log sections', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseSidecar(`${h}  2026-11-05-x.md\n`), h);
  assert.equal(safeVaultPath('../etc/passwd.md'), false);
  assert.equal(safeVaultPath('/abs.md'), false);
  assert.equal(safeVaultPath('Sector 5 — AXON/Research/Session Logs/x.md'), true);
  const p = parseSessionLog(LOG);
  assert.deepEqual(p.decided, ['Match Fit email groups built and merged.']);
  assert.deepEqual(p.openItems, ['Deploy check. Owner: Muse CTO.']);
});
