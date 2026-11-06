// Latency numbers for the health endpoint (D6): P50 / P95 / max plus the
// ack-breach count (short reply later than 3 seconds).
export const ACK_BOUND_MS = 3000;
const MAX_SAMPLES = 1000;

export class Series {
  private xs: number[] = [];
  add(ms: number): void {
    this.xs.push(ms);
    if (this.xs.length > MAX_SAMPLES) this.xs.shift();
  }
  count(): number {
    return this.xs.length;
  }
  pct(p: number): number | null {
    if (this.xs.length === 0) return null;
    const s = [...this.xs].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx] ?? null;
  }
  max(): number | null {
    return this.xs.length ? Math.max(...this.xs) : null;
  }
  summary(): { p50: number | null; p95: number | null; max: number | null; n: number } {
    return { p50: this.pct(50), p95: this.pct(95), max: this.max(), n: this.xs.length };
  }
}

export class Metrics {
  readonly fire = new Series(); // fire -> run id (manual: fire -> brain-row id)
  readonly link = new Series(); // fire -> link
  readonly manualQueue = new Series(); // manual: fire -> claim
  readonly ack = new Series(); // event received -> short reply posted
  ackBreachCount = 0;

  recordAck(ms: number): void {
    this.ack.add(ms);
    if (ms > ACK_BOUND_MS) this.ackBreachCount++;
  }
}
