// Lease handling (D6 failover + Contracts "The verifier is the lease table").
// Lease 90 s, heartbeat 30 s. Acquire with epoch+1. A stale epoch may neither
// fire nor post. 3 missed heartbeats (90 s) → stop firing/posting, alert Muse
// CTO, and resume only after re-acquiring with epoch+1.

import type { BrainApi, LeaseRow } from './brain.js';
import type { Logger } from './util/log.js';
import { iso, type Clock } from './util/time.js';

export const LEASE_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 30_000;
export const MAX_MISSED_HEARTBEATS = 3;

export type LeaseState = 'none' | 'held' | 'lapsed' | 'lost';

export class LeaseHeldElsewhere extends Error {
  constructor(readonly holder: string, readonly epoch: number) {
    super('lease held by another live holder');
    this.name = 'LeaseHeldElsewhere';
  }
}

export interface LeaseSnapshot {
  state: LeaseState;
  epoch: number | null;
  holder: string;
  expiresAt: string | null;
  missedHeartbeats: number;
  lastHeartbeatAt: string | null;
}

export class LeaseManager {
  private state: LeaseState = 'none';
  private epoch: number | null = null;
  private expiresAtMs = 0;
  private missed = 0;
  private lastHeartbeatMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastLiveOkMs: number | null = null;

  constructor(
    private readonly brain: BrainApi,
    readonly name: string, // the CTO key: muse | claude | gemini | axon-hermes
    readonly holder: string, // e.g. "vm:cto-relay-muse"
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly onAlert: (code: string) => void,
  ) {}

  /** Acquire with epoch+1. Throws LeaseHeldElsewhere if another holder's lease is still live. */
  async acquire(): Promise<number> {
    const now = this.clock();
    const row: LeaseRow = {
      name: this.name,
      epoch: 1,
      holder: this.holder,
      acquired_at: iso(now),
      heartbeat_at: iso(now),
      expires_at: iso(now + LEASE_MS),
    };
    const current = await this.brain.getLease(this.name);
    let got: LeaseRow | null;
    if (!current) {
      got = await this.brain.insertLease(row);
      if (!got) return this.acquire(); // lost an insert race: re-read and compete on epoch
    } else {
      const expired = Date.parse(current.expires_at) <= now;
      // Same holder (this host's program restarting under systemd) may take over a live lease;
      // systemd guarantees one process per unit on a host.
      if (!expired && current.holder !== this.holder) throw new LeaseHeldElsewhere(current.holder, current.epoch);
      got = await this.brain.casLease(this.name, current.epoch, { ...row, epoch: current.epoch + 1 });
      if (!got) throw new LeaseHeldElsewhere('race', current.epoch + 1);
    }
    this.epoch = got.epoch;
    this.expiresAtMs = Date.parse(got.expires_at);
    this.state = 'held';
    this.missed = 0;
    this.lastHeartbeatMs = now;
    this.log.info('lease acquired', { lease: this.name, epoch: got.epoch, holder: this.holder });
    return got.epoch;
  }

  startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), LEASE_HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One heartbeat (exposed for tests). */
  async tick(): Promise<void> {
    const now = this.clock();
    if (this.state === 'held' && this.epoch !== null) {
      try {
        const row = await this.brain.renewLease(this.name, this.epoch, iso(now), iso(now + LEASE_MS));
        if (!row) {
          this.state = 'lost';
          this.log.error('lease lost: epoch is stale', { lease: this.name, epoch: this.epoch });
          this.onAlert('lease-lost');
          return;
        }
        this.expiresAtMs = Date.parse(row.expires_at);
        this.missed = 0;
        this.lastHeartbeatMs = now;
      } catch {
        this.missed++;
        this.log.warn('lease heartbeat missed', { lease: this.name, missed: this.missed });
        if (this.missed >= MAX_MISSED_HEARTBEATS) {
          this.state = 'lapsed';
          this.log.error('lease lapsed: 3 missed heartbeats; firing and posting stopped', { lease: this.name });
          this.onAlert('lease-lapsed');
        }
      }
      return;
    }
    if (this.state === 'lapsed' || this.state === 'lost') {
      // Re-acquisition with epoch+1 is required before resuming.
      try {
        await this.acquire();
        this.onAlert('lease-reacquired');
      } catch {
        // still down or held elsewhere — stay stopped
      }
    }
  }

  /**
   * Fence for posts: our epoch is the one the last heartbeat confirmed, and the
   * lease has not run out locally. (At most 30 s stale; a lapsed or lost lease
   * stops posting at once.)
   */
  canAct(): boolean {
    return this.state === 'held' && this.epoch !== null && this.clock() < this.expiresAtMs;
  }

  /** Fence for fires: a live read of the lease row — a stale-epoch fire is refused and logged. */
  async verifyLive(): Promise<boolean> {
    if (!this.canAct() || this.epoch === null) return false;
    const row = await this.brain.getLease(this.name);
    const ok = !!row && row.epoch === this.epoch && row.holder === this.holder;
    if (ok) this.lastLiveOkMs = this.clock();
    if (!ok) {
      this.state = 'lost';
      this.log.error('stale epoch on live check', { lease: this.name, epoch: this.epoch, rowEpoch: row?.epoch ?? null });
      this.onAlert('lease-stale-epoch');
    }
    return ok;
  }

  /** True if a live lease read confirmed our epoch within the last `ms` (lets a short reply reuse the fire's own live check). */
  recentlyVerified(ms: number): boolean {
    return this.canAct() && this.lastLiveOkMs !== null && this.clock() - this.lastLiveOkMs <= ms;
  }

  currentEpoch(): number {
    if (this.epoch === null) throw new Error('no lease');
    return this.epoch;
  }

  snapshot(): LeaseSnapshot {
    return {
      state: this.state,
      epoch: this.epoch,
      holder: this.holder,
      expiresAt: this.expiresAtMs ? iso(this.expiresAtMs) : null,
      missedHeartbeats: this.missed,
      lastHeartbeatAt: this.lastHeartbeatMs !== null ? iso(this.lastHeartbeatMs) : null,
    };
  }
}
