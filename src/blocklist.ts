// Blocklist + redactor + start-pattern strip (D2). One implementation, used by
// the poster, the audit log and the mirror writer alike ("the same blocklist +
// redactor as posts — the relay's poster").

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CtoEntry } from './config.js';

const BlocklistFileSchema = z.object({
  keyPatterns: z.array(z.string()),
  emailPatterns: z.array(z.string()),
  idNumberPatterns: z.array(z.string()),
  privateMatterPatterns: z.array(z.string()),
});

export type BlockRule = 'key' | 'email' | 'id-number' | 'private-matter';

export interface BlocklistHit {
  rule: BlockRule;
  index: number; // which pattern in that group (for the log; never the matched text)
}

export class Blocklist {
  private readonly groups: Array<{ rule: BlockRule; patterns: RegExp[] }>;

  constructor(file: z.infer<typeof BlocklistFileSchema>) {
    const compile = (srcs: string[]): RegExp[] => srcs.map((s) => new RegExp(s, 'giu'));
    // Order matters for redaction: keys first, so a key that also looks like a number is caught as a key.
    this.groups = [
      { rule: 'key', patterns: compile(file.keyPatterns) },
      { rule: 'email', patterns: compile(file.emailPatterns) },
      { rule: 'id-number', patterns: compile(file.idNumberPatterns) },
      { rule: 'private-matter', patterns: compile(file.privateMatterPatterns) },
    ];
  }

  static fromFile(path: string): Blocklist {
    return new Blocklist(BlocklistFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));
  }

  /** Every rule the text hits. Empty means the text is clean. */
  check(text: string): BlocklistHit[] {
    const hits: BlocklistHit[] = [];
    for (const g of this.groups) {
      g.patterns.forEach((re, index) => {
        re.lastIndex = 0;
        if (re.test(text)) hits.push({ rule: g.rule, index });
      });
    }
    return hits;
  }

  /** Replace every hit with "[redacted]". */
  redact(text: string): string {
    let out = text;
    for (const g of this.groups) {
      for (const re of g.patterns) {
        re.lastIndex = 0;
        out = out.replace(re, '[redacted]');
      }
    }
    return out;
  }

  /** Redacted snippet of at most `max` characters (audit log: ≤80, D6). */
  snippet(text: string, max = 80): string {
    const r = this.redact(text).replace(/\s+/g, ' ').trim();
    return r.length <= max ? r : r.slice(0, max - 1) + '…';
  }
}

// ---------------------------------------------------------------------------
// Start pattern (D4) and the post-queue strip (D2)
// ---------------------------------------------------------------------------

/** `<@U123>` or `<@U123|name>` — a real Slack mention. */
const MENTION = String.raw`<@[A-Z0-9]+(?:\|[^>]*)?>`;

/** Plain-text CTO names, as a CTO might type them before the poster turns them into mentions. */
export function plainNamePattern(ctos: CtoEntry[]): string {
  const names = ctos.map((c) => c.displayName.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m));
  return `@(?:${names.join('|')})`;
}

/**
 * The strip (D2): delete any mention plus `fire:` plus the following task words.
 * Applied by the poster to POST-QUEUE text only; start-queue entries are never stripped.
 */
export function stripStartPattern(text: string, ctos: CtoEntry[]): string {
  const re = new RegExp(`(?:${MENTION}|${plainNamePattern(ctos)})\\s*fire:[^\\n]*`, 'giu');
  return text.replace(re, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** True if text carries the start pattern (mention + fire:). Used to assert relay templates never do. */
export function containsStartPattern(text: string, ctos: CtoEntry[]): boolean {
  const re = new RegExp(`(?:${MENTION}|${plainNamePattern(ctos)})\\s*fire:`, 'iu');
  return re.test(text);
}

/** D3: turn plain "@Claude CTO" names into real mentions. Longest names first so "AXON-Hermes CTO" wins. */
export function toRealMentions(text: string, ctos: CtoEntry[]): string {
  let out = text;
  const sorted = [...ctos].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const c of sorted) {
    const esc = c.displayName.replace(/[.*+?^${}()|[\]\\]/g, (m) => '\\' + m);
    out = out.replace(new RegExp(`@${esc}\\b`, 'g'), `<@${c.botUserId}>`);
  }
  return out;
}
