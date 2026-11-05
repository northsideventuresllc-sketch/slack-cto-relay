// Health endpoint (D6): bound to localhost AND the VM LAN address, on the
// per-CTO port (Muse 9101, Claude 9102, Gemini 9103, AXON-Hermes 9104). Only
// this machine and the mini can open it. Answers with latency numbers, queue
// depth, brain lease state, and adapter health.

import { createServer, type Server } from 'node:http';
import type { AdapterHealth, HealthResponse } from './contracts.js';
import type { LeaseSnapshot } from './lease.js';
import type { Metrics } from './metrics.js';

export interface HealthSource {
  cto: string;
  metrics: Metrics;
  queueDepth: () => number;
  lease: () => LeaseSnapshot;
  adapterHealth: () => Promise<AdapterHealth>;
  socketConnected: () => boolean;
  startedAt: number;
}

export interface FullHealth extends HealthResponse {
  cto: string;
  ok: boolean;
  queueDepth: number;
  lease: LeaseSnapshot;
  latency: Record<string, { p50: number | null; p95: number | null; max: number | null; n: number }>;
  socketConnected: boolean;
  uptimeSec: number;
}

const ADAPTER_CACHE_MS = 10_000;

export class HealthServer {
  private servers: Server[] = [];
  private cache: { at: number; value: AdapterHealth } | null = null;

  constructor(private readonly src: HealthSource) {}

  async snapshot(): Promise<FullHealth> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > ADAPTER_CACHE_MS) {
      this.cache = { at: now, value: await this.src.adapterHealth().catch(() => ({ reachable: false, detail: 'health check failed' })) };
    }
    const m = this.src.metrics;
    const lease = this.src.lease();
    const adapter = this.cache.value;
    const socketConnected = this.src.socketConnected();
    return {
      cto: this.src.cto,
      ok: lease.state === 'held' && socketConnected,
      fireLatencyMsP50: m.fire.pct(50),
      linkLatencyMsP50: m.link.pct(50),
      manualQueueLatencyMs: m.manualQueue.pct(50),
      ackBreachCount: m.ackBreachCount,
      adapter,
      queueDepth: this.src.queueDepth(),
      lease,
      latency: { fire: m.fire.summary(), link: m.link.summary(), manualQueue: m.manualQueue.summary(), ack: m.ack.summary() },
      socketConnected,
      uptimeSec: Math.round((now - this.src.startedAt) / 1000),
    };
  }

  /** Bind every address; any bind failure rejects (fail closed — the mini poller depends on the LAN bind). */
  async listen(addresses: string[], port: number): Promise<void> {
    for (const host of addresses) {
      const server = createServer((req, res) => {
        if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/healthz')) {
          res.writeHead(404).end();
          return;
        }
        void this.snapshot().then((h) => {
          res.writeHead(h.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(h));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      this.servers.push(server);
    }
  }

  close(): void {
    for (const s of this.servers) s.close();
  }
}
