// Keys arrive as systemd credentials: ExecStartPre (`cto-relay-fetch-keys <cto>`)
// fetches them fresh from the Secure Vault into tmpfs on every start, and
// LoadCredential hands them to the process via $CREDENTIALS_DIRECTORY (D7).
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
