// Configuration: the CTO registry (config/registry.json) and the process
// environment, both validated with Zod. No secret values live here — keys are
// read from systemd credential files at start (see src/credentials.ts).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const CTO_KEYS = ['muse', 'claude', 'gemini', 'axon-hermes'] as const;
export type CtoKey = (typeof CTO_KEYS)[number];

const PLACEHOLDER = /^<[^>]+>$/;

const CtoEntrySchema = z.object({
  key: z.enum(CTO_KEYS),
  displayName: z.string().min(1),
  appId: z.string().min(1),
  botUserId: z.string().min(1),
  adapter: z.enum(['automatic-muse', 'manual']),
  agentName: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().min(1),
  command: z.string().regex(/^\/fire-[a-z-]+$/),
  healthPort: z.number().int().min(1).max(65535),
  home: z.string().min(1),
  runLinkForm: z.string().min(1),
});
export type CtoEntry = z.infer<typeof CtoEntrySchema>;

const CapsSchema = z.object({
  perFireTokenBudget: z.number().int().positive(),
  monthlyTokenCeiling: z.number().int().positive(),
  weeklyStartFloor: z.number().int().positive(),
  dailyStartCapTotal: z.number().int().positive(),
  monthlyStartCapTotal: z.number().int().positive(),
  perCtoWeeklyManualCap: z.number().int().positive(),
  manualMinutesPerStart: z.number().int().positive(),
  dailyManualMinutesCeiling: z.number().int().positive(),
});
export type Caps = z.infer<typeof CapsSchema>;

export const RegistrySchema = z.object({
  workspace: z.object({ teamId: z.string().min(1), domain: z.string().min(1) }),
  ctoBotsChannelId: z.string().min(1),
  jbUserId: z.string().min(1),
  allowlist: z.object({ extraAuthorIds: z.array(z.string().min(1)) }),
  healthBind: z.array(z.string().min(1)).min(1),
  ctos: z.array(CtoEntrySchema).length(4),
  caps: CapsSchema,
});
export type Registry = z.infer<typeof RegistrySchema>;

const EnvSchema = z.object({
  CTO_RELAY_CTO: z.enum(CTO_KEYS),
  CTO_RELAY_STATE_DIR: z.string().min(1).optional(),
  CTO_RELAY_REGISTRY: z.string().min(1).optional(),
  CTO_RELAY_BLOCKLIST: z.string().min(1).optional(),
  CTO_RELAY_HOLDER: z.string().min(1).default('vm'),
  CTO_RELAY_TZ: z.string().min(1).default('America/New_York'),
  CTO_RELAY_RUN_DIR: z.string().min(1).default('/run/cto-relay'),
  CTO_RELAY_VAULT_DIR: z.string().min(1).optional(),
  CTO_RELAY_VAULT_WEB_BASE: z.string().url().optional(),
  CTO_RELAY_VAULT_REPO_URL: z.string().min(1).optional(),
  CTO_RELAY_HTTPS_PROXY: z.string().url().optional(),
  CTO_RELAY_POST_QUEUE: z.string().min(1).optional(),
  CTO_RELAY_MIRROR_DIR: z.string().min(1).optional(),
  CTO_RELAY_ARCHIVE_DIR: z.string().min(1).optional(),
  CTO_RELAY_HEALTH_BIND: z.string().min(1).optional(),
  SUPABASE_URL: z.string().url().optional(),
  CTO_RELAY_KEY_DIR: z.string().min(1).optional(),
  CREDENTIALS_DIRECTORY: z.string().min(1).optional(),
  CTO_RELAY_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface RelayConfig {
  cto: CtoEntry;
  registry: Registry;
  holder: string; // "vm" | "mini" — goes into cto_relay_lease.holder
  timezone: string;
  stateDir: string; // /var/lib/cto-relay/<cto>
  runDir: string; // /run/cto-relay
  blocklistPath: string;
  vaultDir: string | null;
  vaultWebBase: string | null;
  vaultRepoUrl: string | null; // C2-FU-3: cloned on first close-out read-back
  httpsProxy: string | null;
  postQueuePath: string | null; // Muse only
  mirrorDir: string | null; // Muse only
  archiveDir: string | null; // Muse only: brain rows past 90 days, filed into the vault nightly (R7-FU-12)
  healthBind: string[];
  supabaseUrl: string | null; // Muse only (direct brain access); others use the broker
  credentialsDir: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');

export function loadRegistry(path?: string): Registry {
  const p = path ?? join(REPO_ROOT, 'config', 'registry.json');
  const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
  return RegistrySchema.parse(raw);
}

/** Every placeholder that would stop this CTO's program from starting. */
export function placeholdersBlocking(registry: Registry, cto: CtoKey): string[] {
  const found: string[] = [];
  for (const entry of registry.ctos) {
    if (PLACEHOLDER.test(entry.channelId)) found.push(`${entry.key}.channelId`);
    if (entry.key === cto) {
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === 'string' && PLACEHOLDER.test(v) && k !== 'channelId') found.push(`${entry.key}.${k}`);
      }
    }
  }
  if (PLACEHOLDER.test(registry.ctoBotsChannelId)) found.push('ctoBotsChannelId');
  return found;
}

export function isPlaceholder(v: string): boolean {
  return PLACEHOLDER.test(v);
}

export function ctoEntry(registry: Registry, key: CtoKey): CtoEntry {
  const e = registry.ctos.find((c) => c.key === key);
  if (!e) throw new Error(`registry has no entry for ${key}`);
  return e;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const e = EnvSchema.parse(env);
  const registry = loadRegistry(e.CTO_RELAY_REGISTRY);
  const cto = ctoEntry(registry, e.CTO_RELAY_CTO);
  const stateDir = e.CTO_RELAY_STATE_DIR ?? `/var/lib/cto-relay/${cto.key}`;
  const isMuse = cto.key === 'muse';
  return {
    cto,
    registry,
    holder: e.CTO_RELAY_HOLDER,
    timezone: e.CTO_RELAY_TZ,
    stateDir,
    runDir: e.CTO_RELAY_RUN_DIR,
    blocklistPath: e.CTO_RELAY_BLOCKLIST ?? join(REPO_ROOT, 'config', 'blocklist.json'),
    vaultDir: e.CTO_RELAY_VAULT_DIR ?? null,
    vaultWebBase: e.CTO_RELAY_VAULT_WEB_BASE ?? null,
    vaultRepoUrl: e.CTO_RELAY_VAULT_REPO_URL ?? null,
    httpsProxy: e.CTO_RELAY_HTTPS_PROXY ?? null,
    postQueuePath: isMuse ? (e.CTO_RELAY_POST_QUEUE ?? '/var/lib/cto-relay/muse/post-queue.jsonl') : null,
    mirrorDir: isMuse ? (e.CTO_RELAY_MIRROR_DIR ?? join(stateDir, 'mirror')) : null,
    archiveDir: isMuse ? (e.CTO_RELAY_ARCHIVE_DIR ?? join(stateDir, 'archive')) : null,
    healthBind: e.CTO_RELAY_HEALTH_BIND ? e.CTO_RELAY_HEALTH_BIND.split(',').map((s) => s.trim()) : registry.healthBind,
    supabaseUrl: e.SUPABASE_URL ?? null,
    // The ExecStartPre tmpfs dir wins (fresh fetch on every start, D7); $CREDENTIALS_DIRECTORY is the fallback.
    credentialsDir: e.CTO_RELAY_KEY_DIR ?? e.CREDENTIALS_DIRECTORY ?? null,
    logLevel: e.CTO_RELAY_LOG_LEVEL,
  };
}

/** The five CTO channels: #cto-bots plus the four private CTO channels (D1). */
export function ctoChannelIds(registry: Registry): Set<string> {
  return new Set([registry.ctoBotsChannelId, ...registry.ctos.map((c) => c.channelId)]);
}

/** Authors allowed to start work: the four CTO bots plus any configured extras. */
export function allowedAuthors(registry: Registry): Set<string> {
  return new Set([...registry.ctos.map((c) => c.botUserId), ...registry.allowlist.extraAuthorIds]);
}

/** Effective daily start cap: the lower of the daily cap and the manual-minutes ceiling (D4 manual budget). */
export function effectiveDailyCap(caps: Caps): number {
  const manualPerDay = Math.floor(caps.dailyManualMinutesCeiling / caps.manualMinutesPerStart);
  return Math.min(caps.dailyStartCapTotal, manualPerDay);
}
