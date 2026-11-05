// Brain broker. D7: "The other three programs fetch only their two Slack keys"
// — only the Muse program holds the `cto-relay-muse` brain key. Yet every
// program writes brain rows and holds a lease (D4/D6). The broker squares the
// two: the Muse program serves one Unix socket per manual CTO, and the manual
// programs make their brain calls through it. D4's manual health() rule
// ("reachable means the Muse program is up") follows directly.
//
// Isolation: socket `<runDir>/broker/<cto>.sock`, mode 0660, group
// `cto-relay-<cto>` — only that CTO's service user (and Muse) can connect. The
// broker scopes every call to the socket's CTO: its own agent_comms rows, its
// own lease name, alerts to MUSE only, heartbeat read-only.

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BrainError,
  FireRowSchema,
  HeartbeatRowSchema,
  LeaseRowSchema,
  type BrainApi,
  type FirePatch,
  type FirePatchGuard,
  type FireRow,
  type HeartbeatRow,
  type LeaseRow,
  type NewFireRow,
} from './brain.js';
import type { CtoEntry } from './config.js';
import { ALERT_TO_AGENT } from './alerts.js';
import { ensureDir } from './util/durable.js';
import type { Logger } from './util/log.js';

const RequestSchema = z.object({
  id: z.number().int(),
  op: z.enum([
    'ping',
    'insertFireRow',
    'getFireRow',
    'listFireRows',
    'findFireRowByIdem',
    'patchFireRow',
    'countStarts',
    'insertAlertRow',
    'getLease',
    'insertLease',
    'casLease',
    'renewLease',
    'getHeartbeat',
  ]),
  args: z.array(z.unknown()),
});
type Request = z.infer<typeof RequestSchema>;

const ResponseSchema = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), status: z.number().nullable() }).optional(),
});

export function brokerSocketPath(runDir: string, cto: string): string {
  return join(runDir, 'broker', `${cto}.sock`);
}

class ScopeError extends Error {
  constructor() {
    super('out of scope');
    this.name = 'ScopeError';
  }
}

/** Runs in the Muse program. */
export class BrokerServer {
  private servers: Server[] = [];

  constructor(
    private readonly brain: BrainApi,
    private readonly runDir: string,
    private readonly log: Logger,
  ) {}

  start(manualCtos: CtoEntry[]): void {
    ensureDir(join(this.runDir, 'broker'), 0o755);
    for (const cto of manualCtos) {
      const path = brokerSocketPath(this.runDir, cto.key);
      if (existsSync(path)) unlinkSync(path);
      const server = createServer((sock) => this.serve(sock, cto));
      server.listen(path, () => {
        try {
          const gid = groupId(`cto-relay-${cto.key}`);
          chownSync(path, process.getuid?.() ?? 0, gid);
          chmodSync(path, 0o660);
        } catch {
          chmodSync(path, 0o600); // fail closed: only Muse can connect; that CTO's program refuses to start
          this.log.error('broker socket group not set; manual program will fail closed', { cto: cto.key });
        }
      });
      this.servers.push(server);
    }
  }

  stop(): void {
    for (const s of this.servers) s.close();
    this.servers = [];
  }

  private serve(sock: Socket, cto: CtoEntry): void {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) {
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void this.handleLine(line, cto).then((resp) => sock.write(JSON.stringify(resp) + '\n'));
      }
    });
    sock.on('error', () => undefined);
  }

  private async handleLine(line: string, cto: CtoEntry): Promise<z.infer<typeof ResponseSchema>> {
    let req: Request;
    try {
      req = RequestSchema.parse(JSON.parse(line));
    } catch {
      return { id: -1, ok: false, error: { code: 'bad-request', status: null } };
    }
    try {
      return { id: req.id, ok: true, result: await this.dispatch(req, cto) };
    } catch (err) {
      if (err instanceof ScopeError) {
        this.log.warn('broker call out of scope', { cto: cto.key, op: req.op });
        return { id: req.id, ok: false, error: { code: 'scope', status: null } };
      }
      if (err instanceof BrainError) return { id: req.id, ok: false, error: { code: err.code, status: err.status } };
      return { id: req.id, ok: false, error: { code: 'unreachable', status: null } };
    }
  }

  private async owned(id: string, cto: CtoEntry): Promise<FireRow> {
    const row = await this.brain.getFireRow(id);
    if (!row || row.to_agent !== cto.agentName) throw new ScopeError();
    return row;
  }

  private async dispatch(req: Request, cto: CtoEntry): Promise<unknown> {
    const a = req.args;
    const str = (i: number): string => z.string().parse(a[i]);
    switch (req.op) {
      case 'ping':
        return this.brain.ping();
      case 'insertFireRow': {
        const row = a[0] as NewFireRow;
        if (!row || row.toAgent !== cto.agentName || row.evidence?.cto !== cto.key) throw new ScopeError();
        return this.brain.insertFireRow(row);
      }
      case 'getFireRow': {
        const row = await this.brain.getFireRow(str(0));
        return row && row.to_agent === cto.agentName ? row : null;
      }
      case 'listFireRows':
        if (str(0) !== cto.agentName) throw new ScopeError();
        return this.brain.listFireRows(str(0), z.array(z.string()).parse(a[1]));
      case 'findFireRowByIdem':
        if (str(0) !== cto.agentName) throw new ScopeError();
        return this.brain.findFireRowByIdem(str(0), str(1));
      case 'patchFireRow':
        await this.owned(str(0), cto);
        return this.brain.patchFireRow(str(0), a[1] as FirePatch, a[2] as FirePatchGuard | undefined);
      case 'countStarts':
        return this.brain.countStarts(str(0), a[1] === undefined || a[1] === null ? undefined : str(1));
      case 'insertAlertRow':
        if (str(0) !== ALERT_TO_AGENT) throw new ScopeError();
        return this.brain.insertAlertRow(str(0), str(1), str(2), str(3));
      case 'getLease':
        if (str(0) !== cto.key) throw new ScopeError();
        return this.brain.getLease(str(0));
      case 'insertLease': {
        const row = LeaseRowSchema.parse(a[0]);
        if (row.name !== cto.key) throw new ScopeError();
        return this.brain.insertLease(row);
      }
      case 'casLease': {
        const next = LeaseRowSchema.parse(a[2]);
        if (str(0) !== cto.key || next.name !== cto.key) throw new ScopeError();
        return this.brain.casLease(str(0), z.number().int().parse(a[1]), next);
      }
      case 'renewLease':
        if (str(0) !== cto.key) throw new ScopeError();
        return this.brain.renewLease(str(0), z.number().int().parse(a[1]), str(2), str(3));
      case 'getHeartbeat':
        return this.brain.getHeartbeat(str(0));
    }
  }
}

function groupId(name: string): number {
  const out = execFileSync('getent', ['group', name], { encoding: 'utf8' });
  const gid = Number(out.split(':')[2]);
  if (!Number.isInteger(gid)) throw new Error('no such group');
  return gid;
}

/** Runs in the manual CTOs' programs: the same BrainApi, over the broker socket. */
export class BrokeredBrain implements BrainApi {
  private nextId = 1;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 2500,
  ) {}

  private call(op: Request['op'], args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new BrainError('timeout', null));
      }, this.timeoutMs);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify({ id, op, args }) + '\n'));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        sock.end();
        try {
          const resp = ResponseSchema.parse(JSON.parse(buf.slice(0, nl)));
          if (resp.ok) resolve(resp.result ?? null);
          else {
            const code = resp.error?.code;
            reject(new BrainError(code === 'timeout' ? 'timeout' : code === 'http' ? 'http' : code === 'shape' ? 'shape' : 'unreachable', resp.error?.status ?? null));
          }
        } catch {
          reject(new BrainError('shape', null));
        }
      });
      sock.on('error', () => {
        clearTimeout(timer);
        reject(new BrainError('unreachable', null));
      });
    });
  }

  async ping(): Promise<void> {
    await this.call('ping', []);
  }
  async insertFireRow(row: NewFireRow): Promise<FireRow> {
    return FireRowSchema.parse(await this.call('insertFireRow', [row]));
  }
  async getFireRow(id: string): Promise<FireRow | null> {
    const r = await this.call('getFireRow', [id]);
    return r === null ? null : FireRowSchema.parse(r);
  }
  async listFireRows(toAgent: string, statuses: readonly string[]): Promise<FireRow[]> {
    return z.array(FireRowSchema).parse(await this.call('listFireRows', [toAgent, statuses]));
  }
  async findFireRowByIdem(toAgent: string, idemKey: string): Promise<FireRow | null> {
    const r = await this.call('findFireRowByIdem', [toAgent, idemKey]);
    return r === null ? null : FireRowSchema.parse(r);
  }
  async patchFireRow(id: string, patch: FirePatch, guard?: FirePatchGuard): Promise<FireRow | null> {
    const r = await this.call('patchFireRow', [id, patch, guard]);
    return r === null ? null : FireRowSchema.parse(r);
  }
  async countStarts(sinceIso: string, toAgent?: string): Promise<number> {
    return z.number().int().parse(await this.call('countStarts', [sinceIso, toAgent ?? null]));
  }
  async insertAlertRow(toAgent: string, fromAgent: string, subject: string, body: string): Promise<void> {
    await this.call('insertAlertRow', [toAgent, fromAgent, subject, body]);
  }
  async getLease(name: string): Promise<LeaseRow | null> {
    const r = await this.call('getLease', [name]);
    return r === null ? null : LeaseRowSchema.parse(r);
  }
  async insertLease(row: LeaseRow): Promise<LeaseRow | null> {
    const r = await this.call('insertLease', [row]);
    return r === null ? null : LeaseRowSchema.parse(r);
  }
  async casLease(name: string, expectEpoch: number, next: LeaseRow): Promise<LeaseRow | null> {
    const r = await this.call('casLease', [name, expectEpoch, next]);
    return r === null ? null : LeaseRowSchema.parse(r);
  }
  async renewLease(name: string, epoch: number, heartbeatAt: string, expiresAt: string): Promise<LeaseRow | null> {
    const r = await this.call('renewLease', [name, epoch, heartbeatAt, expiresAt]);
    return r === null ? null : LeaseRowSchema.parse(r);
  }
  async upsertHeartbeat(): Promise<void> {
    throw new BrainError('http', 403); // heartbeat writes belong to the cto-heartbeat cron only
  }
  async getHeartbeat(agent: string): Promise<HeartbeatRow | null> {
    const r = await this.call('getHeartbeat', [agent]);
    return r === null ? null : HeartbeatRowSchema.parse(r);
  }
}
