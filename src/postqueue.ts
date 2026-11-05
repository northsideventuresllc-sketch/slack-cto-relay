// The Muse post-queue (D2): `/var/lib/cto-relay/muse/post-queue.jsonl`, owner
// cto-relay-muse, mode 0600, newline-delimited JSON appended with O_APPEND and
// fsynced per line. Weekly rotation, 7-day retention, 10MB cap — rotated by the
// Muse relay program (rename + create new), never truncated in place.
//
// Entry kinds:
//   {"kind":"post","channel":"cto-bots"|"cto-muse"|…,"text":"…"} — Muse CTO's own words:
//       an ordinary post; the poster strips the start pattern; it can never start work.
//   {"kind":"fire","cto":"muse"|"claude"|"gemini"|"axon-hermes","task":"…"} — JB's start,
//       relayed by Muse CTO (D4: "Muse CTO relays the start into Slack as the Muse CTO bot").
//       For muse: fed to this program's own fire parser path. For another CTO: posted as
//       the explicit start pattern in that CTO's channel, so ONLY that CTO's program parses
//       it (single-parser rule) and exactly one run starts.

import { closeSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync, readdirSync, constants, fstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { CTO_KEYS } from './config.js';
import { appendLineSync, writeFileAtomicSync } from './util/durable.js';
import { DAY, iso, type Clock } from './util/time.js';

export const POST_QUEUE_MAX_BYTES = 10 * 1024 * 1024;
export const POST_QUEUE_ROTATE_MS = 7 * DAY;
export const POST_QUEUE_RETENTION_MS = 7 * DAY;

export const PostQueueEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('post'), channel: z.string().min(1).max(40), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal('fire'), cto: z.enum(CTO_KEYS), task: z.string().min(1).max(280) }),
]);
export type PostQueueEntry = z.infer<typeof PostQueueEntrySchema>;

const OffsetSchema = z.object({ file: z.string(), ino: z.number(), offset: z.number().int().nonnegative(), createdAt: z.string() });

/** Append helper for Muse CTO's writer (run as cto-relay-muse). */
export function appendPostQueue(path: string, entry: PostQueueEntry): void {
  appendLineSync(path, JSON.stringify(PostQueueEntrySchema.parse(entry)), 0o600);
}

export class PostQueueWatcher {
  private readonly offsetPath: string;

  constructor(
    readonly path: string,
    stateDir: string,
    private readonly clock: Clock,
    private readonly onEntry: (e: PostQueueEntry) => Promise<void>,
    private readonly onBad: (reason: string) => void,
  ) {
    this.offsetPath = join(stateDir, 'post-queue.offset.json');
  }

  private readOffset(ino: number): { offset: number; createdAt: string } {
    try {
      const o = OffsetSchema.parse(JSON.parse(require_text(this.offsetPath)));
      if (o.ino === ino) return { offset: o.offset, createdAt: o.createdAt };
    } catch {
      // first run, or a new file
    }
    return { offset: 0, createdAt: iso(this.clock()) };
  }

  private saveOffset(ino: number, offset: number, createdAt: string): void {
    writeFileAtomicSync(this.offsetPath, JSON.stringify({ file: basename(this.path), ino, offset, createdAt }));
  }

  /** One poll: read whole new lines from the saved offset, hand each to onEntry, then rotate if due. */
  async poll(): Promise<void> {
    if (!existsSync(this.path)) closeSync(openSync(this.path, constants.O_CREAT | constants.O_WRONLY, 0o600));
    const ino = statSync(this.path).ino;
    const { offset, createdAt } = this.readOffset(ino);
    const next = await this.consume(this.path, offset);
    if (next !== offset) this.saveOffset(ino, next, createdAt);
    await this.rotateIfDue(createdAt);
  }

  /** Process every complete line after `offset`; returns the new offset. A partial last line is left for the next poll. */
  private async consume(file: string, offset: number): Promise<number> {
    const fd = openSync(file, 'r');
    let text: string;
    try {
      const st = fstatSync(fd);
      if (st.size <= offset) return offset;
      const chunk = Buffer.alloc(st.size - offset);
      readSync(fd, chunk, 0, chunk.length, offset);
      text = chunk.toString('utf8');
    } finally {
      closeSync(fd);
    }
    let pos = offset;
    let nl: number;
    while ((nl = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      pos += Buffer.byteLength(line, 'utf8') + 1;
      if (line.trim()) {
        let parsed: PostQueueEntry | null = null;
        try {
          parsed = PostQueueEntrySchema.parse(JSON.parse(line));
        } catch {
          this.onBad('malformed-entry');
        }
        if (parsed) await this.onEntry(parsed);
      }
      if (file === this.path) this.saveOffset(statSync(this.path).ino, pos, this.readOffset(statSync(this.path).ino).createdAt);
    }
    return pos;
  }

  /**
   * Rotate by rename + create new (never truncate in place) at 10MB or weekly;
   * the rotated file's unread tail is drained before the offset moves to the
   * new file. Rotated files past 7 days are deleted.
   */
  async rotateIfDue(createdAt: string): Promise<void> {
    const now = this.clock();
    const size = existsSync(this.path) ? statSync(this.path).size : 0;
    const due = size >= POST_QUEUE_MAX_BYTES || now - Date.parse(createdAt) >= POST_QUEUE_ROTATE_MS;
    if (due) {
      const ino = statSync(this.path).ino;
      const { offset } = this.readOffset(ino);
      const rotated = `${this.path}.${iso(now).replace(/[:.]/g, '-')}`;
      renameSync(this.path, rotated);
      closeSync(openSync(this.path, constants.O_CREAT | constants.O_WRONLY, 0o600));
      await this.consume(rotated, offset);
      this.saveOffset(statSync(this.path).ino, 0, iso(now));
    }
    const dir = dirname(this.path);
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(basename(this.path) + '.') || name.endsWith('.json')) continue;
      const f = join(dir, name);
      if (now - statSync(f).mtimeMs >= POST_QUEUE_RETENTION_MS) unlinkSync(f);
    }
  }
}

function require_text(p: string): string {
  const fd = openSync(p, 'r');
  try {
    const st = fstatSync(fd);
    const b = Buffer.alloc(st.size);
    readSync(fd, b, 0, st.size, 0);
    return b.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
