import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stillActive, STALL_MS } from '../src/sweep.js';
import { decide } from '../src/poller.js';
import { Journal } from '../src/journal.js';
import { PostQueueWatcher, appendPostQueue, type PostQueueEntry } from '../src/postqueue.js';
import { countWords, isRelayTemplate, T } from '../src/templates.js';
import { effectiveDailyCap, placeholdersBlocking, loadRegistry } from '../src/config.js';
import { BrokerServer, BrokeredBrain, brokerSocketPath } from '../src/broker.js';
import { silentLogger } from '../src/util/log.js';
import { Maintenance } from '../src/maintenance.js';
import { DAY, HOUR, MIN } from '../src/util/time.js';
import { FakeBrain, FakeClock, testRegistry, makeHarness, mention } from './helpers.js';

test('still-active test: (a) live status, (b) CTO channel message < 6 h, (c) started + own-adapter entry < 6 h', () => {
  const now = 10 * DAY;
  assert.equal(stillActive({ adapterState: 'closed', channelMsgAt: null, rowStatus: 'closed', lastAdapterEntryAt: null, now }), false);
  assert.equal(stillActive({ adapterState: 'started', channelMsgAt: null, rowStatus: 'started', lastAdapterEntryAt: null, now }), true);
  assert.equal(stillActive({ adapterState: 'failed', channelMsgAt: now - STALL_MS + 1, rowStatus: 'failed', lastAdapterEntryAt: null, now }), true);
  assert.equal(stillActive({ adapterState: 'expired', channelMsgAt: null, rowStatus: 'started', lastAdapterEntryAt: now - HOUR, now }), true);
  assert.equal(stillActive({ adapterState: 'expired', channelMsgAt: now - STALL_MS, rowStatus: 'started', lastAdapterEntryAt: now - STALL_MS, now }), false);
});

test('mini poller: 30-minute detection, 45-minute alert, failover after 3 failed polls AND a stale heartbeat', () => {
  let s = { museFails: 0, heartbeatAlerted: false, failoverSent: false, lastSweepAt: 0 };
  let r = decide(s, true, 31 * MIN, 0);
  assert.equal(r.d.museOffline, true);
  assert.equal(r.d.alertHeartbeat, false);
  r = decide(r.next, true, 46 * MIN, 0);
  assert.equal(r.d.alertHeartbeat, true);
  r = decide(r.next, true, 47 * MIN, 0);
  assert.equal(r.d.alertHeartbeat, false, 'alert once per incident');
  s = { museFails: 0, heartbeatAlerted: false, failoverSent: false, lastSweepAt: 0 };
  r = decide(s, false, 10 * MIN, 0);
  r = decide(r.next, false, 10 * MIN, 0);
  r = decide(r.next, false, 10 * MIN, 0);
  assert.equal(r.d.failover, false, 'health down but Muse CTO online: no failover');
  r = decide(r.next, false, 31 * MIN, 0);
  assert.equal(r.d.failover, true);
  r = decide(r.next, false, null, 0);
  assert.equal(r.d.failover, false, 'sent once');
  assert.equal(decide(s, false, null, 0).d.museOffline, true, 'brain down → offline (fail-safe)');
});

test('journal compaction: purges terminal fires past 24 h, keeps close-out keys 90 days, never touches in-flight fires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j-'));
  const clock = new FakeClock();
  const j = new Journal(join(dir, 'journal.jsonl'), clock.now);
  const h = (c: string) => c.repeat(64);
  j.append({ kind: 'fire-request', fireId: 'a', hash: h('a') });
  j.append({ kind: 'fire-state', fireId: 'a', hash: '', state: 'closed', closeoutKey: h('c') });
  j.append({ kind: 'fire-request', fireId: 'b', hash: h('b') });
  j.append({ kind: 'breaker-count', fireId: 'b', hash: h('b'), windowStart: new Date(clock.now()).toISOString() });
  clock.advance(2 * DAY);
  j.compact();
  const kinds = j.all().map((r) => `${r.fireId}:${r.kind}:${r.state ?? ''}`);
  assert.deepEqual(kinds, ['a:fire-state:closed', 'b:fire-request:']);
  clock.advance(91 * DAY);
  j.compact();
  assert.deepEqual(j.all().map((r) => r.fireId), ['b']);
  const reloaded = new Journal(join(dir, 'journal.jsonl'), clock.now);
  reloaded.load();
  assert.equal(reloaded.all().length, 1);
});

test('journal: a torn last line (crash mid-write) is skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j-'));
  const p = join(dir, 'journal.jsonl');
  const clock = new FakeClock();
  const j = new Journal(p, clock.now);
  j.append({ kind: 'fire-request', fireId: 'a', hash: 'a'.repeat(64) });
  writeFileSync(p, readFileSync(p, 'utf8') + '{"kind":"fire-req', { flag: 'w' });
  const j2 = new Journal(p, clock.now);
  j2.load();
  assert.equal(j2.all().length, 1);
  assert.equal(j2.badLinesOnLoad, 1);
});

test('post-queue: whole lines only, offset survives restart, rotation by rename + create new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-'));
  const path = join(dir, 'post-queue.jsonl');
  const clock = new FakeClock();
  const seen: PostQueueEntry[] = [];
  const w = new PostQueueWatcher(path, dir, clock.now, async (e) => void seen.push(e), () => undefined);
  appendPostQueue(path, { kind: 'post', channel: 'cto-bots', text: 'hello' });
  writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"post","chan', 'utf8'); // partial line
  await w.poll();
  assert.equal(seen.length, 1);
  writeFileSync(path, readFileSync(path, 'utf8') + 'nel":"cto-bots","text":"second"}\n', 'utf8');
  const w2 = new PostQueueWatcher(path, dir, clock.now, async (e) => void seen.push(e), () => undefined);
  await w2.poll();
  assert.deepEqual(seen.map((e) => (e.kind === 'post' ? e.text : '')), ['hello', 'second']);
  clock.advance(8 * DAY);
  appendPostQueue(path, { kind: 'fire', cto: 'claude', task: 'build it' });
  await w2.poll();
  assert.equal(seen.length, 3);
  assert.equal(readFileSync(path, 'utf8'), '', 'new file after weekly rotation');
});

test('templates: Appendix A word rule (a standalone em dash is not a word); relay templates are recognised', () => {
  assert.equal(countWords('@Claude CTO — Need your call on the Match Fit email groups before we send. The list is ready.'), 18);
  assert.ok(isRelayTemplate(T.alreadyRunning()));
  assert.ok(!isRelayTemplate('Done with the review, @Muse CTO please check'.replace('Done with', 'Finished')));
});

test('config: placeholders block start; effective daily cap is the lower of the daily cap and the manual-minutes ceiling', () => {
  const r = loadRegistry();
  assert.ok(placeholdersBlocking(r, 'muse').includes('muse.channelId'));
  assert.ok(placeholdersBlocking(r, 'gemini').includes('gemini.agentName'));
  assert.equal(placeholdersBlocking(testRegistry(), 'muse').length, 0);
  assert.equal(effectiveDailyCap(r.caps), 1);
});

test('caps: the daily total across all four CTOs is a hard stop on count', async () => {
  const h = await makeHarness('claude');
  (h.core.d.caps as unknown as { caps: { dailyStartCapTotal: number } }).caps.dailyStartCapTotal = 1;
  await h.core.handleEvent(mention(h, 'claude', 'fire: one'));
  h.brain.rows.get(h.brain.insertOrder[0]!)!.status = 'closed'; // finished: frees the lock, still counts
  await new Maintenance(h.core).pollRows();
  await h.advance(MIN);
  await h.core.handleEvent(mention(h, 'claude', 'fire: two'));
  assert.match(h.sender.texts().at(-1)!, /daily start limit/);
});

test('broker: a manual program reaches only its own rows and its own lease name', async () => {
  const clock = new FakeClock();
  const brain = new FakeBrain(clock);
  const reg = testRegistry();
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const server = new BrokerServer(brain, runDir, silentLogger);
  server.start(reg.ctos.filter((c) => c.adapter === 'manual'));
  await new Promise((r) => setTimeout(r, 50));
  const claude = new BrokeredBrain(brokerSocketPath(runDir, 'claude'));
  await claude.ping();
  const ev = { v: 0, cto: 'claude', task_hash: 'h', norm_hash: 'n', epoch: 1 };
  const row = await claude.insertFireRow({ toAgent: 'CLAUDE', fromAgent: 'MUSE', toHarness: 'claude', subject: 's', body: 'b', evidence: ev, firedAt: new Date().toISOString() });
  assert.equal((await claude.getFireRow(row.id))?.id, row.id);
  await assert.rejects(claude.insertFireRow({ toAgent: 'MUSE', fromAgent: 'MUSE', toHarness: 'muse', subject: 's', body: 'b', evidence: { ...ev, cto: 'muse' }, firedAt: '' }));
  await assert.rejects(claude.getLease('muse'));
  const gemini = new BrokeredBrain(brokerSocketPath(runDir, 'gemini'));
  assert.equal(await gemini.getFireRow(row.id), null, 'another CTO cannot read the row');
  await assert.rejects(claude.upsertHeartbeat());
  server.stop();
});

test('brain rows: terminal rows older than 90 days are exported to the vault archive and marked, once', async () => {
  const { MuseDuties } = await import('../src/sweep.js');
  const clock = new FakeClock();
  const brain = new FakeBrain(clock);
  const reg = testRegistry();
  const row = await brain.insertFireRow({ toAgent: 'MUSE', fromAgent: 'MUSE', toHarness: 'muse', subject: 's', body: 'task text', evidence: { v: 0, cto: 'muse', task_hash: 'h', norm_hash: 'n', epoch: 1 }, firedAt: new Date(clock.now()).toISOString() });
  brain.rows.get(row.id)!.status = 'closed';
  brain.rows.get(row.id)!.completed_at = new Date(clock.now()).toISOString();
  clock.advance(91 * DAY);
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  const d = new MuseDuties(brain, reg, {} as never, { history: async () => [] }, clock.now, silentLogger, () => undefined, async () => true);
  assert.equal(await d.archiveOldRows(dir), 1);
  assert.equal(await d.archiveOldRows(dir), 0);
});
