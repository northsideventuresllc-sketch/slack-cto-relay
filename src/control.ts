// Local control socket: how Muse CTO (main chat, on this VM) drives the manual
// state machine and close-outs without ever being a second journal writer. The
// program stays the single writer of its journal, and every command runs in the
// same serial lane as Slack events — so abort-vs-claim is decided by journal
// write order alone (D4).
//
// Socket: <runDir>/<cto>/control.sock, mode 0660, group cto-relay-admin.

import { createServer, createConnection, type Server } from 'node:net';
import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ensureDir } from './util/durable.js';
import { CTO_KEYS } from './config.js';
import type { Logger } from './util/log.js';

export const ControlCommandSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('claim'), fireId: z.string().min(8), name: z.string().min(1).max(80) }),
  z.object({ cmd: z.literal('start'), fireId: z.string().min(8) }),
  z.object({ cmd: z.literal('link'), fireId: z.string().min(8), link: z.string().min(1).max(300) }),
  z.object({ cmd: z.literal('stopped'), fireId: z.string().min(8) }),
  z.object({
    cmd: z.literal('closeout'),
    fireId: z.string().min(8),
    vaultLogPath: z.string().min(1).max(511),
    sessionUrl: z.string().min(1).max(300).nullable().default(null),
    tokens: z.number().int().nonnegative().nullable().default(null),
    minutes: z.number().nonnegative().nullable().default(null),
  }),
  z.object({ cmd: z.literal('review-clear') }),
  z.object({ cmd: z.literal('journal-has'), fireId: z.string().min(8) }),
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('copy-check'), target: z.enum(CTO_KEYS), ids: z.array(z.string().min(1).max(64)).max(20_000) }),
  z.object({ cmd: z.literal('test-fail-next-journal-write') }),
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

export function controlSocketPath(runDir: string, cto: string): string {
  return join(runDir, cto, 'control.sock');
}

export class ControlServer {
  private server: Server | null = null;

  constructor(
    private readonly path: string,
    private readonly handle: (c: ControlCommand) => Promise<unknown>,
    private readonly log: Logger,
  ) {}

  start(): void {
    ensureDir(dirname(this.path), 0o750);
    if (existsSync(this.path)) unlinkSync(this.path);
    this.server = createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > 2 * 1024 * 1024) return void sock.destroy();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        void (async () => {
          let out: unknown;
          try {
            const cmd = ControlCommandSchema.parse(JSON.parse(line));
            out = { ok: true, result: await this.handle(cmd) };
          } catch (err) {
            out = { ok: false, error: err instanceof z.ZodError ? 'bad-command' : 'failed' };
          }
          sock.end(JSON.stringify(out) + '\n');
        })();
      });
      sock.on('error', () => undefined);
    });
    this.server.listen(this.path, () => {
      try {
        const gid = Number(execFileSync('getent', ['group', 'cto-relay-admin'], { encoding: 'utf8' }).split(':')[2]);
        chownSync(this.path, process.getuid?.() ?? 0, gid);
        chmodSync(this.path, 0o660);
      } catch {
        chmodSync(this.path, 0o600);
        this.log.warn('control socket group cto-relay-admin not set; socket is owner-only');
      }
    });
  }

  stop(): void {
    this.server?.close();
  }
}

export function sendControl(path: string, cmd: ControlCommand, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('control timeout'));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(cmd) + '\n'));
    sock.on('data', (c: string) => (buf += c));
    sock.on('end', () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('bad control reply'));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
