// `cto-relay checkin-report` — R7-NEW-5: the dead-alerter fallback, named.
// Claude CTO runs this at ITS OWN daily 9am check-in (not Muse CTO's — an
// offline Muse CTO cannot notice its own stale heartbeat). Run on the mini as
// user cto-relay-muse via deploy/scripts/mini-checkin.sh (brain key on stdin).
// It reports, in plain lines:
//   - Muse CTO's heartbeat age (offline over 30 minutes),
//   - the mini poller's heartbeat age (the poller itself down → the dead alerter),
//   - every alert in /var/lib/cto-relay/mini/alerts.jsonl not yet shown, then
//     records the read position so each alert is shown once.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DirectBrain } from './brain.js';
import { POLLER_AGENT, POLLER_STALE_MS } from './sweep.js';
import { OFFLINE_DETECT_MS } from './poller.js';
import { writeFileAtomicSync } from './util/durable.js';

const ReadPos = z.object({ size: z.number().int().nonnegative(), ino: z.number().optional() });

export function formatAge(ms: number | null): string {
  if (ms === null) return 'unknown (brain unreachable)';
  if (!Number.isFinite(ms)) return 'no row';
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export async function checkinReport(env: NodeJS.ProcessEnv = process.env, out: (l: string) => void = (l) => process.stdout.write(l + '\n')): Promise<number> {
  const url = env.SUPABASE_URL;
  const dir = env.CTO_RELAY_MINI_DIR ?? '/var/lib/cto-relay/mini';
  if (!url) return 78;
  const key = z.object({ brainKey: z.string().min(1) }).parse(JSON.parse(readFileSync(0, 'utf8'))).brainKey;
  const brain = new DirectBrain({ supabaseUrl: url, apiKey: key, timeoutMs: 10_000 });
  const now = Date.now();
  const age = async (agent: string): Promise<number | null> => {
    try {
      const hb = await brain.getHeartbeat(agent);
      return hb ? now - Date.parse(hb.heartbeat_at) : Number.POSITIVE_INFINITY;
    } catch {
      return null;
    }
  };
  const muse = await age('MUSE');
  const poller = await age(POLLER_AGENT);
  out(`Muse CTO heartbeat: ${formatAge(muse)}${muse === null || muse > OFFLINE_DETECT_MS ? ' — OFFLINE: take the manual starts (runbook §6) and check failover (§8).' : ''}`);
  out(`Mini poller heartbeat: ${formatAge(poller)}${poller === null || poller > POLLER_STALE_MS ? ' — POLLER DOWN: restart its cron on the mini (runbook §8).' : ''}`);
  const alerts = join(dir, 'alerts.jsonl');
  const posFile = join(dir, 'alerts.read.json');
  let pos = 0;
  if (existsSync(posFile)) pos = ReadPos.parse(JSON.parse(readFileSync(posFile, 'utf8'))).size;
  if (existsSync(alerts)) {
    const buf = readFileSync(alerts);
    if (buf.length < pos) pos = 0; // rotated since the last read
    const fresh = buf.subarray(pos).toString('utf8').split('\n').filter((l) => l.trim());
    out(fresh.length ? `Unread mini alerts: ${fresh.length}` : 'Unread mini alerts: none');
    for (const l of fresh) out(`  ${l}`);
    writeFileAtomicSync(posFile, JSON.stringify({ size: buf.length }));
  } else {
    out('Unread mini alerts: none (no alerts file)');
  }
  return 0;
}
