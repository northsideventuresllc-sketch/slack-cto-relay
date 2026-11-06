// COUNCIL GATE round 1 follow-ups (VERDICT-gate-p1.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPLY_BREAKER } from '../src/breaker.js';
import { BrokerServer, BrokeredBrain, brokerSocketPath } from '../src/broker.js';
import { MuseDuties } from '../src/sweep.js';
import { Maintenance } from '../src/maintenance.js';
import { ctoEntry } from '../src/config.js';
import { silentLogger } from '../src/util/log.js';
import { DAY, HOUR, MIN } from '../src/util/time.js';
import { FakeBrain, FakeClock, makeHarness, mention, testRegistry } from './helpers.js';

test('OPT-FU-1 / KAR-FU-1: a deposed holder cannot post even inside its last heartbeat interval (live fence on post)', async () => {
  const h = await makeHarness('muse');
  const l = h.brain.leases.get('muse')!;
  h.brain.leases.set('muse', { ...l, epoch: l.epoch + 1, holder: 'mini:cto-relay-muse' });
  assert.equal(h.lease.canAct(), true, 'the cached check alone would still allow it');
  const r = await h.core.d.poster.post(ctoEntry(h.registry, 'muse').channelId, 'Already running. No second run started.', 'template');
  assert.deepEqual(r, { ok: false, reason: 'stale-epoch' });
  assert.equal(h.sender.posts.length, 0);
  assert.equal(h.lease.snapshot().state, 'lost');
});

test('flag #16 unchanged: with the brain DOWN, the cached fence still lets the brain-down reply out (first 90 s)', async () => {
  const h = await makeHarness('muse');
  h.brain.down = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: during outage'));
  assert.match(h.sender.texts()[0]!, /^Queued\. Brain is down\./);
});

test('C2-FU-9: a slow brain cannot push the short reply past the ack budget — the start is held and retried after 1 minute', async () => {
  const h = await makeHarness('muse');
  h.core.d.ackBudgetMs = 60;
  h.brain.delayMs = 150;
  const t0 = Date.now();
  await h.core.handleEvent(mention(h, 'muse', 'fire: slow brain'));
  assert.ok(Date.now() - t0 < 1500, 'reply path bounded');
  assert.match(h.sender.texts()[0]!, /^Queued\. Brain is down\./);
  h.brain.delayMs = 0;
  await h.advance(MIN);
  await new Maintenance(h.core).timers();
  assert.equal(h.brain.rows.size >= 1, true);
  assert.match(h.sender.texts().at(-1)!, /^Started: slow brain/);
  assert.equal([...h.brain.rows.values()].filter((r) => r.status === 'queued').length, 1, 'never written twice');
});

test('KAR-FU-2: broker countStarts — global totals or the socket\'s own agent only', async () => {
  const clock = new FakeClock();
  const brain = new FakeBrain(clock);
  const reg = testRegistry();
  const runDir = mkdtempSync(join(tmpdir(), 'run-'));
  const server = new BrokerServer(brain, runDir, silentLogger);
  server.start(reg.ctos.filter((c) => c.adapter === 'manual'));
  await new Promise((r) => setTimeout(r, 50));
  const claude = new BrokeredBrain(brokerSocketPath(runDir, 'claude'));
  assert.equal(await claude.countStarts(new Date(0).toISOString()), 0);
  assert.equal(await claude.countStarts(new Date(0).toISOString(), 'Claude CTO'), 0);
  await assert.rejects(claude.countStarts(new Date(0).toISOString(), 'Gemini CTO'));
  server.stop();
});

test('OPT-FU-4: the breaker\'s single reply survives a restart inside the window', async () => {
  const h = await makeHarness('muse');
  for (let i = 0; i < 3; i++) {
    await h.core.handleEvent(mention(h, 'muse', 'fire: flaky'));
    await h.core.handleEvent({ ...mention(h, 'muse', ''), ingress: 'message', text: `abort: ${h.brain.insertOrder.at(-1)}` });
    await h.advance(MIN);
  }
  await h.core.handleEvent(mention(h, 'muse', 'fire: flaky'));
  assert.equal(h.sender.texts().at(-1), REPLY_BREAKER);
  const h2 = await makeHarness('muse', { dir: h.dir, clock: h.clock, brain: h.brain });
  await h2.core.handleEvent(mention(h2, 'muse', 'fire: flaky'));
  assert.equal(h2.sender.texts().filter((t) => t === REPLY_BREAKER).length, 0, 'not sent again after the restart');
});

test('KAR-FU-4: a person\'s /fire command gets a plain refusal, not silence', async () => {
  const h = await makeHarness('claude');
  const claude = ctoEntry(h.registry, 'claude');
  await h.core.handleEvent({ eventId: '', channelId: claude.channelId, authorId: h.registry.jbUserId, text: 'do a thing', timestamp: '1.1', ingress: 'slash_command', command: '/fire-claude', triggerId: 'T1' });
  assert.equal(h.sender.texts().at(-1), 'Starts come from the CTO bots only. Ask Muse CTO in main chat.');
  assert.equal(h.brain.rows.size, 0);
});

test('ECO-FU-2: every start leaves a cost line — a cancelled start costs 0 tokens', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: one'));
  const id = h.brain.insertOrder[0]!;
  await h.core.handleEvent({ ...mention(h, 'claude', ''), ingress: 'message', text: `abort: ${id}` });
  const cost = readFileSync(join(h.dir, 'run-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'cost');
  assert.equal(cost.length, 1);
  assert.equal(cost[0].fireId, id);
  assert.equal(cost[0].tokens, 0);
});

test('OPT-FU-3: a held brain-down start writes its run-log `started` entry at once', async () => {
  const h = await makeHarness('muse');
  h.brain.down = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: held'));
  const started = readFileSync(join(h.dir, 'run-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'started');
  assert.equal(started.length, 1);
  assert.match(started[0].fireId, /^p-/);
});

test('C1-FU-4: a long task is clamped to 10 words in the short reply', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'muse', 'fire: one two three four five six seven eight nine ten eleven twelve'));
  assert.match(h.sender.texts()[0]!, /^Started: one two three four five six seven eight nine ten… — fire id /);
});

test('OPT-FU-2: a `linked` brain row with no journal entry is marked failed by the reconciler', async () => {
  const h = await makeHarness('claude');
  const claude = ctoEntry(h.registry, 'claude');
  const row = await h.brain.insertFireRow({ toAgent: 'Claude CTO', fromAgent: 'MUSE', toHarness: 'claude', subject: 's', body: 'b', firedAt: new Date(h.clock.now()).toISOString(), evidence: { v: 0, cto: 'claude', task_hash: 'x', norm_hash: 'y', epoch: 1, slack: { channel_id: claude.channelId, ts: null, permalink: null } } });
  h.brain.rows.get(row.id)!.status = 'linked';
  await h.advance(10 * MIN);
  await new Maintenance(h.core).reconcile();
  assert.equal(h.brain.rows.get(row.id)?.status, 'failed');
});

test('ECO-FU-3: the Monday review measures starts/week and raises the kill-switch condition after two flat weeks below the floor', async () => {
  const h = await makeHarness('muse');
  const dir = mkdtempSync(join(tmpdir(), 'wk-'));
  const alerts: string[] = [];
  const d = new MuseDuties(h.brain, h.registry, h.core.d.poster, { history: async () => [] }, h.clock.now, silentLogger, (c) => void alerts.push(c), async () => true, 'America/New_York');
  const caps = { monthlyTokenCeiling: 600_000, weeklyFloor: 5 };
  await h.core.handleEvent(mention(h, 'muse', 'fire: one'));
  await h.advance(7 * DAY);
  const w1 = await d.weeklyReview(dir, caps);
  assert.equal(w1.startsTotal, 1);
  assert.equal(w1.belowFloor, true);
  assert.equal(w1.killSwitchCondition, false);
  await h.advance(7 * DAY);
  const w2 = await d.weeklyReview(dir, caps);
  assert.equal(w2.startsTotal, 0);
  assert.equal(w2.killSwitchCondition, true);
  assert.ok(alerts.includes('kill-switch-condition-met'));
  assert.equal((await d.weeklyReview(dir, caps)).weekStart, w2.weekStart, 'one line per week');
});

test('ECO-FU-4: a row whose archived_at patch failed is not appended to the archive twice', async () => {
  const clock = new FakeClock();
  const brain = new FakeBrain(clock);
  const reg = testRegistry();
  const row = await brain.insertFireRow({ toAgent: 'MUSE', fromAgent: 'MUSE', toHarness: 'muse', subject: 's', body: 't', evidence: { v: 0, cto: 'muse', task_hash: 'h', norm_hash: 'n', epoch: 1 }, firedAt: new Date(clock.now()).toISOString() });
  brain.rows.get(row.id)!.status = 'closed';
  brain.rows.get(row.id)!.completed_at = new Date(clock.now()).toISOString();
  clock.advance(91 * DAY);
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  const d = new MuseDuties(brain, reg, {} as never, { history: async () => [] }, clock.now, silentLogger, () => undefined, async () => true);
  const realPatch = brain.patchFireRow.bind(brain);
  brain.patchFireRow = async () => null; // the marking patch fails
  await d.archiveOldRows(dir);
  brain.patchFireRow = realPatch;
  await d.archiveOldRows(dir);
  const lines = readFileSync(join(dir, (await import('node:fs')).readdirSync(dir)[0]!), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
});
