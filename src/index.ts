#!/usr/bin/env node
// cto-relay CLI.
//   cto-relay run                         one relay program (CTO from CTO_RELAY_CTO)
//   cto-relay heartbeat                   write Muse CTO's cto_heartbeat row (cron cto-heartbeat)
//   cto-relay poller                      the mini poller (1-minute cron on the mini; secrets on stdin)
//   cto-relay admin <cmd> --cto <cto> …   control socket: claim | start | link | stopped | closeout | review-clear | journal-has | status
//   cto-relay post-queue-append …         append one validated entry to the Muse post-queue (run as cto-relay-muse)

import { loadConfig } from './config.js';
import { ControlCommandSchema, controlSocketPath, sendControl } from './control.js';
import { writeHeartbeat } from './heartbeat.js';
import { runPoller } from './poller.js';
import { appendPostQueue, PostQueueEntrySchema } from './postqueue.js';
import { RelayProgram } from './relay.js';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) {
      const v = argv[i + 1];
      out[a.slice(2)] = v !== undefined && !v.startsWith('--') ? (i++, v) : 'true';
    }
  }
  return out;
}

const num = (v: string | undefined): number | null => (v === undefined ? null : Number(v));

async function main(): Promise<number> {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run':
      return new RelayProgram(loadConfig()).run();
    case 'heartbeat':
      return writeHeartbeat();
    case 'poller':
      return runPoller();
    case 'admin': {
      const [sub, ...more] = rest;
      const f = flags(more);
      const cto = f.cto ?? process.env.CTO_RELAY_CTO;
      if (!sub || !cto) {
        process.stderr.write('usage: cto-relay admin <cmd> --cto <cto> [--fire-id ID] [--name N] [--link L] [--vault-log-path P] [--session-url U] [--tokens N] [--minutes N]\n');
        return 64;
      }
      const command = ControlCommandSchema.parse({
        cmd: sub,
        fireId: f['fire-id'],
        name: f.name,
        link: f.link,
        vaultLogPath: f['vault-log-path'],
        sessionUrl: f['session-url'] ?? null,
        tokens: num(f.tokens),
        minutes: num(f.minutes),
      });
      const res = await sendControl(controlSocketPath(process.env.CTO_RELAY_RUN_DIR ?? '/run/cto-relay', cto), command);
      process.stdout.write(JSON.stringify(res) + '\n');
      return (res as { ok?: boolean }).ok ? 0 : 1;
    }
    case 'post-queue-append': {
      const f = flags(rest);
      const entry = PostQueueEntrySchema.parse(f.kind === 'fire' ? { kind: 'fire', cto: f.cto, task: f.task } : { kind: 'post', channel: f.channel, text: f.text });
      appendPostQueue(process.env.CTO_RELAY_POST_QUEUE ?? '/var/lib/cto-relay/muse/post-queue.jsonl', entry);
      return 0;
    }
    default:
      process.stderr.write(`unknown command ${cmd}\n`);
      return 64;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(JSON.stringify({ msg: 'fatal', err: (err as { name?: string }).name ?? 'error' }) + '\n');
    process.exit(1);
  },
);
