// Round-7 verdict items (VERDICT-r7.md): R7-NEW-1..7 and the follow-ups that changed behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MuseDuties, POLLER_AGENT } from '../src/sweep.js';
import { Maintenance } from '../src/maintenance.js';
import { Closeouts } from '../src/closeout.js';
import { Outbox } from '../src/outbox.js';
import { PostQueueWatcher, appendPostQueue, type PostQueueEntry } from '../src/postqueue.js';
import { appendLineCapped } from '../src/util/durable.js';
import { ctoEntry } from '../src/config.js';
import { sha256 } from '../src/util/hash.js';
import { silentLogger } from '../src/util/log.js';
import { DAY, HOUR, MIN } from '../src/util/time.js';
import type { ReadBack, VaultReader } from '../src/vault.js';
import { makeHarness, mention, FakeClock, type Harness } from './helpers.js';

function duties(h: Harness, alerts: string[] = []): MuseDuties {
  return new MuseDuties(h.brain, h.registry, h.core.d.poster, { history: async () => [] }, h.clock.now, silentLogger, (c) => void alerts.push(c), async () => true);
}

test('R7-NEW-1 + R7-NEW-2: a run silent for 6 hours is flagged stalled and the warning is posted to the CTO channel at once, once', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'claude', 'fire: x', { channelId: ctoEntry(h.registry, 'muse').channelId, text: `<@${ctoEntry(h.registry, 'muse').botUserId}> fire: x` }));
  const id = h.brain.insertOrder[0]!;
  await h.core.claim(id, 'Muse CTO');
  await h.core.markStarted(id);
  await h.advance(6 * HOUR + MIN);
  const alerts: string[] = [];
  const d = duties(h, alerts);
  const f = await d.sweep();
  assert.deepEqual(f.map((x) => x.kind), ['stalled']);
  assert.equal(h.sender.texts().at(-1), `No activity for 6 hours on fire id ${id}. It may be stalled. Muse CTO has been told.`);
  assert.equal(h.sender.posts.at(-1)!.channel, ctoEntry(h.registry, 'muse').channelId);
  const before = h.sender.posts.length;
  await d.sweep();
  assert.equal(h.sender.posts.length, before, 'posted once per silence');
  assert.ok(alerts.includes('run-stalled'));
  await h.advance(19 * HOUR);
  assert.deepEqual((await d.sweep()).map((x) => x.kind), ['stalled', 'unclosed']);
});

test('R7-NEW-3: a start owed its 1-hour retry is reported lost after a restart (content was held in memory only)', async () => {
  const h = await makeHarness('muse');
  h.core.handleStartIngress = async () => {
    throw new Error('boom');
  };
  await h.core.handleEvent(mention(h, 'muse', 'fire: x'));
  assert.match(h.sender.texts().at(-1)!, /One more try in 1 hour/);
  assert.equal(h.core.pendingRetries.size, 1);
  assert.ok(h.journal.all().some((r) => r.state === 'retry-pending'));
  assert.ok(!JSON.stringify(h.journal.all()).includes('fire: x'), 'no event text on disk');
  const h2 = await makeHarness('muse', { dir: h.dir, clock: h.clock, brain: h.brain });
  await new Maintenance(h2.core).reconcile();
  assert.equal(h2.sender.texts().at(-1), 'A start waiting for its one retry was lost when the relay restarted. Please re-send it.');
  await new Maintenance(h2.core).reconcile();
  assert.equal(h2.sender.posts.length, 1, 'reported once');
});

test('R7-NEW-3: the retry itself replays the held event once, then clears its marker', async () => {
  const h = await makeHarness('muse');
  const real = h.core.handleStartIngress.bind(h.core);
  let fail = true;
  h.core.handleStartIngress = async (ev, ctx) => {
    if (fail) throw new Error('boom');
    return real(ev, ctx);
  };
  const scheduled: Array<() => void> = [];
  h.core.d.schedule = (_ms, fn) => void scheduled.push(fn);
  await h.core.handleEvent(mention(h, 'muse', 'fire: replay me'));
  fail = false;
  await h.advance(HOUR);
  scheduled[0]!();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.brain.rows.size, 1);
  assert.equal(h.core.lostRetries().length, 0);
});

test('R7-NEW-5: the Muse program watches the mini poller heartbeat — stale → visible post + alert once; back → posted', async () => {
  const h = await makeHarness('muse');
  const alerts: string[] = [];
  const d = duties(h, alerts);
  await h.brain.upsertHeartbeat(POLLER_AGENT, new Date(h.clock.now()).toISOString());
  await d.watchPoller();
  assert.equal(h.sender.posts.length, 0);
  await h.advance(6 * MIN);
  await d.watchPoller();
  await d.watchPoller();
  assert.equal(h.sender.texts().filter((t) => t.startsWith('The mini poller has stopped')).length, 1);
  assert.ok(alerts.includes('mini-poller-stale'));
  await h.brain.upsertHeartbeat(POLLER_AGENT, new Date(h.clock.now()).toISOString());
  await d.watchPoller();
  assert.equal(h.sender.texts().at(-1), 'The mini poller is back.');
});

test('R7-NEW-5: alerts.jsonl is capped and rotated by rename, never truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-'));
  const p = join(dir, 'alerts.jsonl');
  for (let i = 0; i < 50; i++) appendLineCapped(p, JSON.stringify({ i, pad: 'x'.repeat(40) }), 500, 2);
  assert.ok(readFileSync(p, 'utf8').length <= 500);
  assert.ok(existsSync(`${p}.1`) && existsSync(`${p}.2`) && !existsSync(`${p}.3`));
});

test('R7-NEW-6: 3 accepted attempts trip the breaker; the 4th is refused and NOT recorded', async () => {
  const h = await makeHarness('muse');
  for (let i = 0; i < 3; i++) {
    await h.core.handleEvent(mention(h, 'muse', 'fire: same'));
    await h.core.handleEvent({ ...mention(h, 'muse', ''), ingress: 'message', text: `abort: ${h.brain.insertOrder.at(-1)}` });
    await h.advance(MIN);
  }
  await h.core.handleEvent(mention(h, 'muse', 'fire: same'));
  assert.equal(h.brain.rows.size, 3);
  assert.equal(h.journal.all().filter((r) => r.kind === 'breaker-count').length, 3, 'the refused 4th is not recorded');
});

const GEMINI_LOG = '## Decided\n- Research done.\n\n## Session\n- mini session gem-42 + Slack thread\n\n## Open items\n';
class Vault implements VaultReader {
  constructor(private text: string) {}
  set(t: string): void {
    this.text = t;
  }
  async readBack(): Promise<ReadBack> {
    const bytes = Buffer.from(this.text);
    return { ok: true, bytes, hash: sha256(bytes) };
  }
  webUrl(p: string): string {
    return `https://vault.invalid/${encodeURIComponent(p)}`;
  }
}

test('R7-NEW-7: a Gemini Session pointer (not a link) must be filed in the vault log; the map cites the vault path', async () => {
  const h = await makeHarness('gemini');
  await h.core.handleEvent(mention(h, 'gemini', 'fire: research'));
  const id = h.brain.insertOrder[0]!;
  await h.core.claim(id, 'Muse CTO');
  await h.core.setLink(id, 'mini session gem-42 + Slack thread');
  const vault = new Vault('## Decided\n- Research done.\n');
  const co = new Closeouts(h.core, new Outbox(h.dir), vault, h.core.d.caps);
  const before = h.sender.posts.length;
  assert.deepEqual(await co.submit({ fireId: id, vaultLogPath: 'S/Session Logs/g.md', sessionUrl: null, tokens: null, minutes: null }), { ok: true, reason: 'queued-in-outbox' });
  assert.equal(h.sender.posts.length, before, 'not filed in the log → nothing posted');
  assert.ok(h.alerts.includes('closeout-session-not-filed-in-log'));
  vault.set(GEMINI_LOG);
  await h.advance(5 * MIN);
  await co.drain();
  const map = h.sender.posts.at(-2)!.text;
  assert.match(map, /^Session: mini session gem-42 \+ Slack thread \(filed in the log: S\/Session Logs\/g\.md\)$/m);
});

test('R7-FU-6: a late write that lands in the rotated post-queue file is still drained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-'));
  const path = join(dir, 'post-queue.jsonl');
  // Rotation is weekly by the program's clock; start 8 days back so file mtimes stay "fresh".
  const clock = new FakeClock(Date.now() - 8 * DAY);
  const seen: PostQueueEntry[] = [];
  const w = new PostQueueWatcher(path, dir, clock.now, async (e) => void seen.push(e), () => undefined);
  appendPostQueue(path, { kind: 'post', channel: 'cto-bots', text: 'a' });
  await w.poll();
  clock.advance(8 * DAY);
  await w.poll(); // rotates
  const rotated = (await import('node:fs')).readdirSync(dir).find((n) => n.startsWith('post-queue.jsonl.'))!;
  writeFileSync(join(dir, rotated), readFileSync(join(dir, rotated), 'utf8') + JSON.stringify({ kind: 'post', channel: 'cto-bots', text: 'late' }) + '\n');
  clock.advance(10_000);
  await w.poll();
  assert.deepEqual(seen.map((e) => (e.kind === 'post' ? e.text : '')), ['a', 'late']);
});

test('R5-FU-9: the copy check posts a gap when a brain row has no journal record in the copy', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: one'));
  const id = h.brain.insertOrder[0]!;
  await h.advance(2 * HOUR);
  const m = await makeHarness('muse', { brain: h.brain, clock: h.clock });
  const d = duties(m);
  assert.deepEqual(await d.copyCheck(ctoEntry(h.registry, 'claude'), [id]), { gap: 0 });
  assert.deepEqual(await d.copyCheck(ctoEntry(h.registry, 'claude'), []), { gap: 1 });
  assert.equal(m.sender.texts().at(-1), 'Nightly copy check: 1 start(s) for Claude CTO are missing from the journal copy. Muse CTO has been told.');
});

test('R7-FU-2: health carries queue depth and lease state', async () => {
  const { HealthServer } = await import('../src/health.js');
  const h = await makeHarness('muse');
  const hs = new HealthServer({ cto: 'muse', metrics: h.core.d.metrics, queueDepth: () => h.book.depth(), lease: () => h.lease.snapshot(), adapterHealth: () => h.core.d.adapter.health(), socketConnected: () => true, startedAt: 0 });
  const snap = await hs.snapshot();
  assert.equal(snap.queueDepth, 0);
  assert.equal(snap.leaseState, 'held');
  assert.equal(h.core.d.adapter.liveStatus, false, 'KAR-6: v1 adapters have no live probe');
});
