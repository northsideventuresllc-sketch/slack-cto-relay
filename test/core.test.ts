import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctoEntry } from '../src/config.js';
import { BREAKER_WINDOW_MS, REPLY_BREAKER } from '../src/breaker.js';
import { Maintenance } from '../src/maintenance.js';
import { HOUR, MIN } from '../src/util/time.js';
import { containsStartPattern } from '../src/blocklist.js';
import { makeHarness, mention, fireIdFromReply } from './helpers.js';

test('write order: brain row → journal → short reply; reply says "started automatically" with the fire id', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'muse', 'fire: Build the Match Fit email groups'));
  assert.equal(h.brain.rows.size, 1);
  const id = h.brain.insertOrder[0]!;
  const req = h.journal.all().find((r) => r.kind === 'fire-request');
  assert.equal(req?.fireId, id);
  assert.equal(req?.hash.length, 64);
  assert.ok(!JSON.stringify(h.journal.all()).includes('Match Fit'), 'journal holds hashes only');
  const reply = h.sender.texts()[0]!;
  assert.match(reply, /^Started: Build the Match Fit email groups — fire id [0-9a-f-]+ — started automatically — run link to follow\.$/);
  assert.equal(fireIdFromReply(reply), id);
  assert.ok(!/fired/i.test(reply));
});

test('manual CTO reply says "queued for a person" and names the home', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: test task'));
  assert.match(h.sender.texts()[0]!, /queued for a person\. Muse CTO will start it in Claude Code\.$/);
});

test('journal-failure test: a journal write failure voids the row; the start never runs', async () => {
  const h = await makeHarness('muse');
  h.journal.faults.failNextWrite = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: something'));
  const row = [...h.brain.rows.values()][0]!;
  assert.equal(row.status, 'refused', 'row voided first');
  assert.equal(h.journal.all().filter((r) => r.kind === 'fire-request').length, 0);
  assert.equal(h.book.depth(), 0);
  assert.match(h.sender.texts()[0]!, /^Not started\./);
});

test('ingress test: "@Claude CTO fire: test task" starts one run in Claude only; an ordinary post starts none', async () => {
  const claude = await makeHarness('claude');
  const gemini = await makeHarness('gemini', { brain: claude.brain, clock: claude.clock });
  const ev = mention(claude, 'claude', 'fire: test task');
  await claude.core.handleEvent(ev);
  // The Gemini program only ever sees this as a `message` event (broadcast) — never parsed.
  await gemini.core.handleEvent({ ...ev, ingress: 'message' });
  assert.equal(claude.brain.rows.size, 1);
  assert.equal(gemini.book.depth(), 0);
  await claude.core.handleEvent(mention(claude, 'claude', 'the list is ready'));
  assert.equal(claude.brain.rows.size, 1);
});

test('relay replies never carry the start pattern, even when the task text does', async () => {
  const h = await makeHarness('muse');
  const claude = ctoEntry(h.registry, 'claude');
  await h.core.handleEvent(mention(h, 'muse', `fire: tell <@${claude.botUserId}> fire: deploy`));
  for (const t of h.sender.texts()) assert.ok(!containsStartPattern(t, h.registry.ctos), t);
});

test('dedup precedence: event redelivery dropped; same task within 30 min dropped; a cancelled start can be re-sent', async () => {
  const h = await makeHarness('muse');
  const ev = mention(h, 'muse', 'fire: deploy X');
  await h.core.handleEvent(ev);
  await h.core.handleEvent(ev); // Slack redelivery
  assert.equal(h.brain.rows.size, 1);
  const id = h.brain.insertOrder[0]!;
  // abort it, then re-send the same task: allowed (it never ran)
  await h.core.handleEvent({ ...mention(h, 'muse', ''), ingress: 'message', text: `abort: ${id}` });
  assert.equal(h.brain.rows.get(id)?.status, 'cancelled');
  await h.advance(2 * MIN);
  await h.core.handleEvent(mention(h, 'muse', 'fire: Deploy X!'));
  assert.equal(h.brain.rows.size, 2);
});

test('already running: a second start for a CTO with a run going is ignored with the fixed reply', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: task one'));
  await h.advance(MIN);
  await h.core.handleEvent(mention(h, 'claude', 'fire: task two'));
  assert.equal(h.brain.rows.size, 1);
  assert.equal(h.sender.texts().at(-1), 'Already running. No second run started.');
});

test('breaker restart test: trip the breaker, restart inside the window, the count survives', async () => {
  const h = await makeHarness('muse');
  for (let i = 0; i < 3; i++) {
    await h.core.handleEvent(mention(h, 'muse', 'fire: flaky task'));
    const id = [...h.brain.rows.keys()].at(-1)!;
    await h.core.handleEvent({ ...mention(h, 'muse', ''), ingress: 'message', text: `abort: ${id}` });
    await h.advance(MIN);
  }
  assert.equal(h.journal.all().filter((r) => r.kind === 'breaker-count').length, 3);
  // restart: a fresh program over the same state dir and brain
  const h2 = await makeHarness('muse', { dir: h.dir, clock: h.clock, brain: h.brain });
  await h2.core.handleEvent(mention(h2, 'muse', 'fire: flaky task'));
  assert.equal(h2.sender.texts().at(-1), REPLY_BREAKER);
  assert.equal(h.brain.rows.size, 3, 'no fourth run');
  await h2.core.handleEvent(mention(h2, 'muse', 'fire: flaky task'));
  assert.equal(h2.sender.texts().filter((t) => t === REPLY_BREAKER).length, 1, 'replies once, then silent');
  await h2.advance(BREAKER_WINDOW_MS);
  await h2.core.handleEvent(mention(h2, 'muse', 'fire: flaky task'));
  assert.equal(h.brain.rows.size, 4, 'count resets after the window');
});

test('abort-vs-claim: abort before claim cancels; claim after abort is refused (journal write time decides)', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: a'));
  const id = h.brain.insertOrder[0]!;
  await h.core.handleEvent({ ...mention(h, 'claude', ''), ingress: 'message', text: `abort: ${id}` });
  assert.equal(h.brain.rows.get(id)?.status, 'cancelled');
  assert.deepEqual(await h.core.claim(id, 'Muse CTO'), { ok: false, reason: 'unknown-or-closed' });
});

test('abort-vs-claim: claim first → the abort becomes a stop request; "stopped" after Muse CTO stops it', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: b'));
  const id = h.brain.insertOrder[0]!;
  assert.equal((await h.core.claim(id, 'Muse CTO')).ok, true);
  assert.equal(h.brain.rows.get(id)?.status, 'claimed');
  await h.advance(1000);
  await h.core.handleEvent({ ...mention(h, 'claude', ''), ingress: 'message', text: `abort: ${id}` });
  assert.match(h.sender.texts().at(-1)!, /stop request/);
  await h.core.markStopped(id);
  assert.equal(h.sender.texts().at(-1), `stopped: fire id ${id}.`);
});

test('manual state machine: claim → start → link posts the run link and writes linked; lock held until closed', async () => {
  const h = await makeHarness('gemini');
  await h.core.handleEvent(mention(h, 'gemini', 'fire: research'));
  const id = h.brain.insertOrder[0]!;
  await h.core.claim(id, 'Muse CTO');
  await h.core.markStarted(id);
  await h.core.setLink(id, 'mini session gem-42 + Slack thread');
  assert.equal(h.brain.rows.get(id)?.status, 'linked');
  assert.equal(h.sender.texts().at(-1), 'Run: mini session gem-42 + Slack thread');
  await h.advance(MIN);
  await h.core.handleEvent(mention(h, 'gemini', 'fire: other'));
  assert.equal(h.sender.texts().at(-1), 'Already running. No second run started.');
});

test('brain down: start held in memory, journal holds only the hash; a restart reports the lost start', async () => {
  const h = await makeHarness('muse');
  h.brain.down = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: during outage'));
  assert.match(h.sender.texts()[0]!, /^Queued\. Brain is down\. Will retry\./);
  const rec = h.journal.all().find((r) => r.kind === 'fire-request');
  assert.equal(rec?.provisional, true);
  assert.ok(!JSON.stringify(h.journal.all()).includes('during outage'));
  // relay restarts mid-outage → held text is gone; when the brain is back, the reconciler posts the loss notice
  h.brain.down = false;
  const h2 = await makeHarness('muse', { dir: h.dir, clock: h.clock, brain: h.brain });
  await new Maintenance(h2.core).reconcile();
  assert.equal(h2.sender.texts().at(-1), 'A start was lost when the relay restarted. Please re-send it.');
});

test('brain down then back: the hourly retry writes the row and posts the real fire id', async () => {
  const h = await makeHarness('muse');
  h.brain.down = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: retry me'));
  h.brain.down = false;
  await h.advance(HOUR);
  await new Maintenance(h.core).timers();
  assert.equal(h.brain.rows.size, 1);
  assert.equal(fireIdFromReply(h.sender.texts().at(-1)!), h.brain.insertOrder[0]);
});

test('brain down past 24 hours: "Not started. Brain was down too long."', async () => {
  const h = await makeHarness('muse');
  h.brain.down = true;
  await h.core.handleEvent(mention(h, 'muse', 'fire: too long'));
  await h.advance(24 * HOUR); // the lease lapses while the brain is down: no posting
  assert.equal(h.lease.canAct(), false);
  h.brain.down = false;
  await h.lease.tick(); // re-acquire with epoch+1
  await new Maintenance(h.core).timers();
  assert.equal(h.sender.texts().at(-1), 'Not started. Brain was down too long.');
});

test('reconciler: a brain row with no journal entry (journal-failure orphan) is marked failed and the requester told', async () => {
  const h = await makeHarness('claude');
  const claude = ctoEntry(h.registry, 'claude');
  const row = await h.brain.insertFireRow({
    toAgent: 'CLAUDE',
    fromAgent: 'MUSE',
    toHarness: 'claude',
    subject: 's',
    body: 'b',
    firedAt: new Date(h.clock.now()).toISOString(),
    evidence: { v: 0, cto: 'claude', task_hash: 'x', norm_hash: 'y', epoch: 1, slack: { channel_id: claude.channelId, ts: null, permalink: null } },
  });
  await h.advance(10 * MIN);
  await new Maintenance(h.core).reconcile();
  assert.equal(h.brain.rows.get(row.id)?.status, 'failed');
  assert.match(h.sender.texts().at(-1)!, /was not recorded properly/);
});

test('stale epoch: after another holder takes epoch+1, this program may neither fire nor post', async () => {
  const h = await makeHarness('muse');
  const l = h.brain.leases.get('muse')!;
  h.brain.leases.set('muse', { ...l, epoch: l.epoch + 1, holder: 'mini:cto-relay-muse' });
  await h.core.handleEvent(mention(h, 'muse', 'fire: x'));
  assert.equal(h.brain.rows.size, 0);
  assert.equal(h.sender.posts.length, 0);
});

test('lease: 3 missed heartbeats stop firing and posting; re-acquire with epoch+1 to resume', async () => {
  const h = await makeHarness('muse');
  const epoch = h.lease.currentEpoch();
  h.brain.down = true;
  for (let i = 0; i < 3; i++) await h.lease.tick();
  assert.equal(h.lease.snapshot().state, 'lapsed');
  assert.equal(h.lease.canAct(), false);
  h.brain.down = false;
  h.clock.advance(2 * MIN);
  await h.lease.tick();
  assert.equal(h.lease.snapshot().state, 'held');
  assert.equal(h.lease.currentEpoch(), epoch + 1);
});

test('fires outside the five CTO channels and from non-allowlisted authors are ignored (no reply, no start)', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'muse', 'fire: x', { channelId: 'COTHER001' }));
  await h.core.handleEvent(mention(h, 'muse', 'fire: x', { authorId: h.registry.jbUserId }));
  assert.equal(h.brain.rows.size, 0);
  assert.equal(h.sender.posts.length, 0);
});

test('Muse link window: no link 35 minutes after the start → visible failure + alert', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'muse', 'fire: x'));
  await h.advance(35 * MIN);
  await new Maintenance(h.core).timers();
  assert.match(h.sender.texts().at(-1)!, /^No run link yet/);
  assert.ok(h.alerts.includes('run-link-window-missed'));
});

test('Muse run link written by the drain into the row is posted by the 5-minute check', async () => {
  const h = await makeHarness('muse');
  await h.core.handleEvent(mention(h, 'muse', 'fire: x'));
  const id = h.brain.insertOrder[0]!;
  const row = h.brain.rows.get(id)!;
  row.status = 'started';
  (row.evidence as { relay: { run_chat_url?: string } }).relay.run_chat_url = 'https://muse.ai/chat/run-1';
  await new Maintenance(h.core).pollRows();
  assert.equal(h.sender.texts().at(-1), 'Run: https://muse.ai/chat/run-1');
  assert.equal(h.brain.rows.get(id)?.status, 'linked');
});

test('unclaimed manual start: "Still waiting on a person" at 30 minutes, expiry at 24 hours', async () => {
  const h = await makeHarness('claude');
  await h.core.handleEvent(mention(h, 'claude', 'fire: x'));
  await h.advance(30 * MIN);
  const m = new Maintenance(h.core);
  await m.timers();
  assert.match(h.sender.texts().at(-1)!, /^Still waiting on a person\. Next check-in at /);
  await h.advance(24 * HOUR);
  await m.timers();
  assert.equal(h.sender.texts().at(-1), 'Not started. It expired.');
  assert.equal(h.brain.rows.get(h.brain.insertOrder[0]!)?.status, 'expired');
});

test('restore: re-posts a failed short reply from the brain row and posts the current state', async () => {
  const h = await makeHarness('claude');
  h.sender.fail = true;
  await h.core.handleEvent(mention(h, 'claude', 'fire: restore me'));
  h.sender.fail = false;
  const h2 = await makeHarness('claude', { dir: h.dir, clock: h.clock, brain: h.brain });
  await new Maintenance(h2.core).restore();
  assert.match(h2.sender.texts()[0]!, /^Started: restore me/);
  assert.match(h2.sender.texts()[1]!, /^Still waiting: fire id/);
});
