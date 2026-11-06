// Vault read-back (D5 step 2): the relay reads the filed session log back
// LIVE, hashes the bytes it just read, and compares the hash to the `.sha256`
// sidecar next to it. Only a match lets the map post.
//
// Read path: a local git checkout of the vault. The relay fetches, then reads
// the committed bytes on the remote main branch (`git show origin/main:<path>`)
// — so a log that is not filed (committed and pushed) does not read back.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { sha256 } from './util/hash.js';

const run = promisify(execFile);

export interface ReadBack {
  ok: boolean;
  reason?: 'not-configured' | 'fetch-failed' | 'log-missing' | 'sidecar-missing' | 'sidecar-bad' | 'hash-mismatch' | 'bad-path';
  bytes?: Buffer;
  hash?: string;
}

export interface VaultReader {
  readBack(path: string): Promise<ReadBack>;
  webUrl(path: string): string | null;
}

export function safeVaultPath(p: string): boolean {
  return p.length > 0 && p.length < 512 && !p.startsWith('/') && !p.split('/').includes('..') && !/[\0\n\r]/.test(p) && p.endsWith('.md');
}

/** Parse a sidecar: the first 64-hex token (plain hash, or `sha256sum` output). */
export function parseSidecar(text: string): string | null {
  const m = /\b([0-9a-f]{64})\b/i.exec(text);
  return m?.[1]?.toLowerCase() ?? null;
}

export class GitVaultReader implements VaultReader {
  constructor(
    private readonly dir: string | null,
    private readonly webBase: string | null, // CTO_RELAY_VAULT_WEB_BASE, e.g. https://github.com/<owner>/<vault-repo>/blob/main
    private readonly branch = 'main',
    /** C2-FU-3: the read-only vault deploy key (label `cto-relay-vault-read`), fetched into this program's tmpfs key dir. */
    private readonly readKeyPath: string | null = null,
    private readonly knownHosts = '/etc/cto-relay/known_hosts',
    /** C2-FU-3: the vault repo (CTO_RELAY_VAULT_REPO_URL); the checkout is created on first use, no manual clone step. */
    private readonly repoUrl: string | null = null,
  ) {}

  private gitEnv(): NodeJS.ProcessEnv {
    if (!this.readKeyPath || !existsSync(this.readKeyPath)) return process.env;
    return {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i ${this.readKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${this.knownHosts}`,
    };
  }

  private async show(path: string): Promise<Buffer | null> {
    try {
      const { stdout } = await run('git', ['-C', this.dir ?? '', 'show', `origin/${this.branch}:${path}`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      return stdout as unknown as Buffer;
    } catch {
      return null;
    }
  }

  async readBack(path: string): Promise<ReadBack> {
    if (!this.dir) return { ok: false, reason: 'not-configured' };
    if (!safeVaultPath(path)) return { ok: false, reason: 'bad-path' };
    if (!existsSync(`${this.dir}/.git`) && this.repoUrl) {
      try {
        // Read-only use: no working tree needed — read-back reads `origin/main:<path>` objects.
        await run('git', ['clone', '--quiet', '--no-checkout', this.repoUrl, this.dir], { timeout: 300_000, env: this.gitEnv() });
      } catch {
        return { ok: false, reason: 'fetch-failed' };
      }
    }
    try {
      await run('git', ['-C', this.dir, 'fetch', '--quiet', 'origin', this.branch], { timeout: 60_000, env: this.gitEnv() });
    } catch {
      return { ok: false, reason: 'fetch-failed' };
    }
    const bytes = await this.show(path);
    if (!bytes) return { ok: false, reason: 'log-missing' };
    const side = await this.show(`${path}.sha256`);
    if (!side) return { ok: false, reason: 'sidecar-missing' };
    const want = parseSidecar(side.toString('utf8'));
    if (!want) return { ok: false, reason: 'sidecar-bad' };
    const got = sha256(bytes);
    if (got !== want) return { ok: false, reason: 'hash-mismatch', hash: got };
    return { ok: true, bytes, hash: got };
  }

  webUrl(path: string): string | null {
    if (!this.webBase) return null;
    return this.webBase.replace(/\/+$/, '') + '/' + path.split('/').map(encodeURIComponent).join('/');
  }
}

/**
 * The structured session log (D5 step 1): decided, why, what failed, reusable,
 * open items with owners — as `## <Section>` headings. Returns the sections
 * the map needs. Missing sections read as empty.
 */
export function parseSessionLog(md: string): { decided: string[]; openItems: string[] } {
  const sections = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of md.split('\n')) {
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (h?.[1]) {
      cur = h[1].toLowerCase();
      sections.set(cur, []);
      continue;
    }
    if (cur && line.trim()) sections.get(cur)?.push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  const pick = (...names: string[]): string[] => {
    for (const [k, v] of sections) if (names.some((n) => k.startsWith(n))) return v;
    return [];
  };
  return { decided: pick('decided', 'done', 'outcome'), openItems: pick('open items', 'still open', 'open') };
}
