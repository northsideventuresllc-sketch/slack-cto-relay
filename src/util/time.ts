// Time helpers in a named IANA zone (the 9am CTO check-in is local time).
export type Clock = () => number;
export const realClock: Clock = () => Date.now();

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function zonedParts(ms: number, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
  };
}

/** The UTC instant of a wall-clock time in `tz` (handles DST by re-checking the offset). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    const diff = want - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function startOfLocalDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Week starts Monday 00:00 local (the Monday review). */
export function startOfLocalWeek(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const back = (p.weekday + 6) % 7; // days since Monday
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, tz);
}

export function startOfLocalMonth(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedToUtc(p.year, p.month, 1, 0, 0, tz);
}

/** The next occurrence of hh:mm local strictly after `ms`. */
export function nextLocalTime(ms: number, hour: number, minute: number, tz: string): number {
  const p = zonedParts(ms, tz);
  let t = zonedToUtc(p.year, p.month, p.day, hour, minute, tz);
  let n = 0;
  while (t <= ms && n < 3) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1 + n));
    t = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, tz);
    n++;
  }
  return t;
}

/** "9:00 AM ET, Thu Nov 6" style label for "Next check-in at [time]". */
export function formatLocal(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
