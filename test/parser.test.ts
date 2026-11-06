import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbort, parseStart, REPLY_EMPTY, REPLY_MULTI, REPLY_NOT_FIRE_COMMAND, REPLY_TOO_LONG } from '../src/parser.js';
import { ctoEntry } from '../src/config.js';
import { normalizeTask } from '../src/util/hash.js';
import type { SlackEvent } from '../src/contracts.js';
import { testRegistry } from './helpers.js';

const reg = testRegistry();
const claude = ctoEntry(reg, 'claude');
const muse = ctoEntry(reg, 'muse');
const ev = (text: string, extra: Partial<SlackEvent> = {}): SlackEvent => ({
  eventId: 'Ev1',
  channelId: claude.channelId,
  authorId: muse.botUserId,
  text,
  timestamp: '1.1',
  ingress: 'app_mention',
  ...extra,
});

test('mention + fire: starts; fire: is case-insensitive', () => {
  assert.deepEqual(parseStart(ev(`<@${claude.botUserId}> fire: build the groups`), claude, reg), { kind: 'start', task: 'build the groups' });
  assert.deepEqual(parseStart(ev(`<@${claude.botUserId}> FIRE: x`), claude, reg), { kind: 'start', task: 'x' });
});

test('a bare mention never starts work', () => {
  assert.equal(parseStart(ev(`<@${claude.botUserId}> the list is ready`), claude, reg).kind, 'ignore');
});

test('single-parser rule: a message event never feeds the fire parser', () => {
  assert.equal(parseStart(ev(`<@${claude.botUserId}> fire: test task`, { ingress: 'message' }), claude, reg).kind, 'ignore');
});

test('code blocks and quote lines are stripped before matching', () => {
  assert.equal(parseStart(ev('```<@' + claude.botUserId + '> fire: x```'), claude, reg).kind, 'ignore');
  assert.equal(parseStart(ev('`<@' + claude.botUserId + '> fire: x`'), claude, reg).kind, 'ignore');
  assert.equal(parseStart(ev(`&gt; <@${claude.botUserId}> fire: x`), claude, reg).kind, 'ignore');
});

test('empty, too long, multiple mentions', () => {
  assert.deepEqual(parseStart(ev(`<@${claude.botUserId}> fire:   `), claude, reg), { kind: 'reply', text: REPLY_EMPTY, reason: 'empty' });
  assert.equal((parseStart(ev(`<@${claude.botUserId}> fire: ${'a'.repeat(281)}`), claude, reg) as { text: string }).text, REPLY_TOO_LONG);
  const multi = ev(`<@${claude.botUserId}> fire: x <@${muse.botUserId}>`);
  assert.deepEqual(parseStart(multi, claude, reg), { kind: 'reply', text: REPLY_MULTI, reason: 'multi-mention' });
  // only the first-mentioned CTO's program replies
  assert.equal(parseStart({ ...multi, channelId: muse.channelId }, muse, reg).kind, 'ignore');
});

test('a close-out map tagging all four never starts work', () => {
  const map = `Done: x\nLog: <https://e.invalid|l>\nSession: s\nStill open: None\n\n${reg.ctos.map((c) => `<@${c.botUserId}>`).join(' ')}`;
  for (const c of reg.ctos) assert.equal(parseStart(ev(map, { channelId: c.channelId }), c, reg).kind, 'ignore');
});

test('slash commands: own /fire command starts; any other command gets the fixed reply', () => {
  assert.deepEqual(parseStart(ev('build it', { ingress: 'slash_command', command: '/fire-claude' }), claude, reg), { kind: 'start', task: 'build it' });
  assert.deepEqual(parseStart(ev('x', { ingress: 'slash_command', command: '/deploy' }), claude, reg), { kind: 'reply', text: REPLY_NOT_FIRE_COMMAND, reason: 'not-fire-command' });
});

test('edits never re-fire; events over 10KB are dropped', () => {
  assert.equal(parseStart(ev(`<@${claude.botUserId}> fire: x`, { edited: true }), claude, reg).kind, 'ignore');
  assert.equal(parseStart(ev(`<@${claude.botUserId}> fire: ${'x'.repeat(11000)}`), claude, reg).kind, 'ignore');
});

test('abort parsing', () => {
  assert.equal(parseAbort('abort: 9f2c1a2b-1111-2222-3333-444455556666'), '9f2c1a2b-1111-2222-3333-444455556666');
  assert.equal(parseAbort('ABORT: 9f2c1a2b'), '9f2c1a2b');
  assert.equal(parseAbort('please abort: 9f2c1a2b'), null);
  assert.equal(parseAbort('abort: 9f2c'), null);
});

test('normalization: "Deploy X" and "deploy X!" are the same task (NFKC, case, punctuation, whitespace)', () => {
  assert.equal(normalizeTask('Deploy X'), normalizeTask('deploy  X!'));
  assert.equal(normalizeTask('ｄｅｐｌｏｙ X'), normalizeTask('deploy x'));
});
