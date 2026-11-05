// The mini poller (D4/D6/D7): a 1-minute cron ON THE MINI.
// - Curls the VM health endpoints (http://<vm-lan>:9101/health …9104).
// - Offline rule: Muse CTO is offline when its cto_heartbeat row is older than
//   30 minutes (detection); the alert fires at 45 minutes (3 missed writes).
// - Failover is detected when the VM's Muse health endpoint does not answer for
//   3 consecutive 1-minute polls AND the heartbeat is older than 30 minutes.
//   On failover with Muse CTO offline, the poller itself sends the agent_comms
//   row to CLAUDE.
// - Alert transport: an agent_comms row addressed to CLAUDE; if the brain is
//   down, the local file /var/lib/cto-relay/mini/alerts.jsonl (read by Claude CTO
//   at the next morning check-in).
// - Dead-owner fallback (D5 §6): while the Muse relay program is down, the
//   poller runs the close-out sweep (brain rows + Slack history) every 6 hours.
// Secrets arrive on stdin as JSON from the mini's login keychain — never argv/env/disk.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WebClient, LogLevel } from '@slack/web-api';
import { DirectBrain, type BrainApi } from './brain.js';
import { loadRegistry, type Registry } from './config.js';
import { MuseDuties } from './sweep.js';
import type { Poster } from './poster.js';
import { appendLineSync, writeFileAtomicSync } from './util/durable.js';
import { createLogger } from './util/log.js';
import { HOUR, MIN } from './util/time.js';

export const OFFLINE_DETECT_MS = 30 * MIN;
export const OFFLINE_ALERT_MS = 45 * MIN;
export const FAILOVER_POLLS = 3;
const ALERT_TO = 'CLAUDE';
const FROM = 'CTO-RELAY-MINI-POLLER';

const StateSchema = z.object({
  museFails: z.number().int().nonnegative().default(0),
  heartbeatAlerted: z.boolean().default(false),
  failoverSent: z.boolean().default(false),
  lastSweepAt: z.number().default(0),
});
type PollerState = z.infer<typeof StateSchema>;

const SecretsSchema = z.object({ brainKey: z.string().min(1), slackBotToken: z.string().min(1).optional() });

export interface PollerDecision {
  heartbeatAgeMs: number | null; // null = brain down (treated as offline)
  museOffline: boolean;
  alertHeartbeat: boolean;
  failover: boolean;
  runSweep: boolean;
}

/** Pure decision step (unit-tested). */
export function decide(state: PollerState, museHealthy: boolean, heartbeatAgeMs: number | null, now: number): { next: PollerState; d: PollerDecision } {
  const museFails = museHealthy ? 0 : state.museFails + 1;
  const offline = heartbeatAgeMs === null || heartbeatAgeMs > OFFLINE_DETECT_MS;
  const alertDue = (heartbeatAgeMs === null || heartbeatAgeMs > OFFLINE_ALERT_MS) && !state.heartbeatAlerted;
  const failoverDue = museFails >= FAILOVER_POLLS && offline && !state.failoverSent;
  const sweepDue = museFails >= FAILOVER_POLLS && now - state.lastSweepAt >= 6 * HOUR;
  return {
    next: {
      museFails,
      heartbeatAlerted: offline ? state.heartbeatAlerted || alertDue : false,
      failoverSent: museHealthy ? false : state.failoverSent || failoverDue,
      lastSweepAt: sweepDue ? now : state.lastSweepAt,
    },
    d: { heartbeatAgeMs, museOffline: offline, alertHeartbeat: alertDue, failover: failoverDue, runSweep: sweepDue },
  };
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

export async function runPoller(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const log = createLogger('cto-relay-mini-poller');
  const stateDir = env.CTO_RELAY_MINI_DIR ?? '/var/lib/cto-relay/mini';
  const statePath = join(stateDir, 'poller-state.json');
  const alertsPath = join(stateDir, 'alerts.jsonl');
  const registry: Registry = loadRegistry(env.CTO_RELAY_REGISTRY);
  const vmLan = env.CTO_RELAY_VM_LAN ?? registry.healthBind.find((h) => h !== '127.0.0.1') ?? '127.0.0.1';
  const url = env.SUPABASE_URL;
  if (!url) return 78;
  const secrets = SecretsSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
  const brain: BrainApi = new DirectBrain({ supabaseUrl: url, apiKey: secrets.brainKey, timeoutMs: 10_000 });

  const state = existsSync(statePath) ? StateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8'))) : StateSchema.parse({});
  const health: Record<string, boolean> = {};
  for (const c of registry.ctos) health[c.key] = await probe(`http://${vmLan}:${c.healthPort}/health`);
  let hbAge: number | null = null;
  try {
    const hb = await brain.getHeartbeat('MUSE');
    hbAge = hb ? Date.now() - Date.parse(hb.heartbeat_at) : Number.POSITIVE_INFINITY;
  } catch {
    hbAge = null;
  }
  const now = Date.now();
  const { next, d } = decide(state, health.muse === true, hbAge, now);

  const send = async (subject: string, body: Record<string, unknown>): Promise<void> => {
    try {
      await brain.insertAlertRow(ALERT_TO, FROM, subject, JSON.stringify(body));
    } catch {
      appendLineSync(alertsPath, JSON.stringify({ at: new Date(now).toISOString(), subject, ...body }));
    }
  };
  if (d.alertHeartbeat) await send('Muse CTO heartbeat is older than 45 minutes', { heartbeatAgeMs: hbAge, health });
  if (d.failover) await send('cto-relay failover: VM Muse relay down 3 polls and Muse CTO offline. Run cto-relay-mini-sync.sh (checked step) then start the mini relays.', { heartbeatAgeMs: hbAge, health });
  if (d.runSweep && secrets.slackBotToken) {
    const web = new WebClient(secrets.slackBotToken, { logLevel: LogLevel.ERROR, retryConfig: { retries: 0 } });
    const history = {
      history: async (channel: string, oldest: string) =>
        ((await web.conversations.history({ channel, oldest, limit: 200 })).messages ?? []).map((m) => ({ user: m.user ?? null, text: m.text ?? '', ts: m.ts ?? '' })),
    };
    const noPost = { post: async () => ({ ok: false, reason: 'empty' }) } as unknown as Poster; // the fallback sweep never posts as a bot
    const duties = new MuseDuties(brain, registry, noPost, history, () => now, log, () => undefined, async () => false);
    const findings = await duties.sweep();
    if (findings.length) await send('cto-relay fallback sweep findings (Muse relay down)', { findings });
  }
  writeFileAtomicSync(statePath, JSON.stringify(next));
  log.info('poll', { health, heartbeatAgeMs: hbAge, museFails: next.museFails, failover: d.failover });
  return 0;
}
