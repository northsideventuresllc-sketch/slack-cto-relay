// Keys arrive through tmpfs: ExecStartPre (`cto-relay-fetch-keys <cto>`) fetches
// them fresh from the Secure Vault into /run/credentials/cto-relay-<cto>/ on
// every start, and the unit passes that directory to the process as
// CTO_RELAY_KEY_DIR (D7). No unit uses `LoadCredential=` — systemd loads those
// before ExecStartPre runs, which would break "fresh fetch wins" (KAR-FU-3).
// $CREDENTIALS_DIRECTORY is read only as a fallback when CTO_RELAY_KEY_DIR is unset.
// Values are never logged, never written anywhere else.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CRED_SLACK_APP = 'slack-app-token';
export const CRED_SLACK_BOT = 'slack-bot-token';
export const CRED_BRAIN = 'brain-key';

export class MissingCredential extends Error {
  constructor(readonly credName: string) {
    super(`missing credential ${credName}`);
    this.name = 'MissingCredential';
  }
}

export function readCredential(dir: string | null, name: string): string {
  if (!dir) throw new MissingCredential(name);
  const p = join(dir, name);
  if (!existsSync(p)) throw new MissingCredential(name);
  const v = readFileSync(p, 'utf8').trim();
  if (!v) throw new MissingCredential(name);
  return v;
}
