// Durable-disk helpers: every write that matters is fsynced (D6 durable state).
import { openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, existsSync, readFileSync, constants, chmodSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(path: string, mode = 0o700): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

/** Append one line with O_APPEND and fsync it before returning (no partial-line reads). */
export function appendLineSync(path: string, line: string, mode = 0o600): void {
  if (line.includes('\n')) throw new Error('appendLineSync: line must not contain a newline');
  ensureDir(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, mode);
  try {
    writeSync(fd, line + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write a whole file atomically: write tmp, fsync, rename over, fsync the directory. */
export function writeFileAtomicSync(path: string, content: string, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
  fsyncDir(dirname(path));
}

export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some platforms (macOS on certain filesystems) refuse fsync on a directory; the rename is still atomic.
  }
}

/** Read newline-delimited JSON; a torn final line (crash mid-write) is skipped, never parsed. */
export function readJsonLines(path: string): { values: unknown[]; badLines: number } {
  if (!existsSync(path)) return { values: [], badLines: 0 };
  const raw = readFileSync(path, 'utf8');
  const values: unknown[] = [];
  let badLines = 0;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      badLines++;
    }
  }
  return { values, badLines };
}

export const ALERTS_MAX_BYTES = 1024 * 1024;
export const ALERTS_KEEP = 3;

/**
 * Append to a size-capped log (alerts.jsonl, R7-NEW-5): past `maxBytes` the file
 * is rotated by rename (path → path.1 → … → path.<keep>; the oldest is dropped),
 * never truncated in place.
 */
export function appendLineCapped(path: string, line: string, maxBytes = ALERTS_MAX_BYTES, keep = ALERTS_KEEP, mode = 0o600): void {
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) + 1 > maxBytes) {
    const oldest = `${path}.${keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
  }
  appendLineSync(path, line, mode);
}
