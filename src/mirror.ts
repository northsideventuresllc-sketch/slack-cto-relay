// Mirroring (D5): every fire, decision, and blocker thread is summed up into
// the vault — one short entry per fire and per close-out, one-line summary.
// Sole mirror writer: the Muse relay program. Entries pass through the same
// blocklist + redactor as posts.
// R7-FU-11 — filing: the relay host files the mirror into the vault WITHIN A DAY.
// The nightly cto-relay-offhost-copy.sh (root, 02:30) copies this directory to
// $VAULT_MIRROR_PATH in the vault checkout and commits + pushes it. Muse CTO's
// weekly job is the mirror CHECK (thread links + a secrets sample), not the filing.
// A night whose filing fails raises the off-host hygiene alert.

import { join } from 'node:path';
import type { Blocklist } from './blocklist.js';
import type { Registry } from './config.js';
import type { SlackEvent } from './contracts.js';
import { appendLineSync } from './util/durable.js';
import { iso, startOfLocalWeek, zonedParts, type Clock } from './util/time.js';

export type MirrorKind = 'fire' | 'closeout' | 'blocker' | 'decision';

export function classifyForMirror(text: string, inCtoBots: boolean): MirrorKind | null {
  if (text.startsWith('Started:')) return 'fire';
  if (text.startsWith('Close-out:')) return 'closeout';
  if (inCtoBots && /\bBlocked\b/.test(text)) return 'blocker';
  if (inCtoBots && /\b(need your call|decision|decided)\b/i.test(text)) return 'decision';
  return null;
}

export class MirrorWriter {
  constructor(
    private readonly dir: string,
    private readonly registry: Registry,
    private readonly blocklist: Blocklist,
    private readonly clock: Clock,
    private readonly tz: string,
  ) {}

  /** Weekly file, named by the Monday of the week (local time). */
  fileFor(ms: number): string {
    const p = zonedParts(startOfLocalWeek(ms, this.tz), this.tz);
    const mm = String(p.month).padStart(2, '0');
    const dd = String(p.day).padStart(2, '0');
    return join(this.dir, `cto-loop-mirror-${p.year}-${mm}-${dd}.md`);
  }

  observe(ev: SlackEvent): MirrorKind | null {
    const cto = this.registry.ctos.find((c) => c.botUserId === ev.authorId);
    if (!cto) return null;
    const inCtoBots = ev.channelId === this.registry.ctoBotsChannelId;
    const kind = classifyForMirror(ev.text, inCtoBots);
    if (!kind) return null;
    const summary = this.blocklist.snippet(ev.text.split('\n')[0] ?? '', 120).replace(/\|/g, '/');
    const link = `https://${this.registry.workspace.domain}/archives/${ev.channelId}/p${ev.timestamp.replace('.', '')}`;
    const now = this.clock();
    appendLineSync(this.fileFor(now), `- ${iso(now)} | ${kind} | ${cto.displayName} | ${summary} | ${link}`, 0o640);
    return kind;
  }
}
