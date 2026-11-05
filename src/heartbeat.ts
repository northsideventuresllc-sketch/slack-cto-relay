// cto-heartbeat (D4): Muse CTO's liveness row, written every 15 minutes by the
// cron `cto-heartbeat` on the VM (systemd timer), with the cto-relay-muse
// brain key. Table cto_heartbeat (agent, heartbeat_at).

import { DirectBrain } from './brain.js';
import { CRED_BRAIN, readCredential } from './credentials.js';

export async function writeHeartbeat(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = env.SUPABASE_URL;
  if (!url) {
    process.stderr.write('SUPABASE_URL not set\n');
    return 78;
  }
  const brain = new DirectBrain({ supabaseUrl: url, apiKey: readCredential(env.CTO_RELAY_KEY_DIR ?? env.CREDENTIALS_DIRECTORY ?? null, CRED_BRAIN), httpsProxy: env.CTO_RELAY_HTTPS_PROXY ?? null, timeoutMs: 10_000 });
  try {
    await brain.upsertHeartbeat('MUSE', new Date().toISOString());
    process.stdout.write(JSON.stringify({ msg: 'heartbeat written', agent: 'MUSE' }) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(JSON.stringify({ msg: 'heartbeat failed', err: (err as { code?: string }).code ?? 'error' }) + '\n');
    return 1;
  }
}
