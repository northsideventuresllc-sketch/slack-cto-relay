// HarnessAdapter v1 implementations. Both write the brain row (agent_comms) as
// the start record: for Muse it is the start request the mailbox drain picks
// up; for the manual CTOs it is the live handoff record (D4 manual state
// machine). The run id is the brain-row id, which is also the fire id quoted
// in the short reply (R6-NEW-4) — one value everywhere.

import type { AdapterHealth, FireRequest, FireStatus, HarnessAdapter, RunState } from '../contracts.js';
import type { CtoEntry } from '../config.js';
import { relayEvidence, type BrainApi, type FireRow, type RelayEvidence } from '../brain.js';
import { iso, type Clock } from '../util/time.js';

export class AlreadyClaimedError extends Error {
  constructor(readonly state: string) {
    super('run already claimed');
    this.name = 'AlreadyClaimedError';
  }
}

/** Manual queue cap (D4): the pending manual queue is under its cap of 10 waiting starts. */
export const MANUAL_QUEUE_CAP = 10;

abstract class BrainHandoffAdapter implements HarnessAdapter {
  constructor(
    protected readonly brain: BrainApi,
    protected readonly cto: CtoEntry,
    protected readonly clock: Clock,
  ) {}

  protected abstract readonly startStatus: FireStatus;

  async fire(req: FireRequest): Promise<{ runId: string; runChatUrl: string | null; status: FireStatus }> {
    const meta = req.meta;
    if (!meta) throw new Error('fire() needs meta');
    const now = iso(this.clock());
    const evidence: RelayEvidence = {
      v: 0,
      cto: this.cto.key,
      task_hash: meta.taskHash,
      norm_hash: meta.normHash,
      idem_key: meta.idemKey,
      epoch: req.epoch,
      slack: { channel_id: meta.channelId, ts: meta.messageTs, permalink: meta.permalink },
      run_chat_url: null,
      last_progress_at: now,
      writer: `cto-relay-${this.cto.key}`,
    };
    const row = await this.brain.insertFireRow({
      toAgent: this.cto.agentName,
      fromAgent: meta.fromAgent,
      toHarness: this.cto.key,
      subject: `Start for ${this.cto.displayName}`,
      body: req.task,
      evidence,
      firedAt: now,
    });
    return { runId: row.id, runChatUrl: null, status: this.startStatus };
  }

  async status(runId: string): Promise<{ state: RunState; runChatUrl: string | null }> {
    const row = await this.brain.getFireRow(runId);
    if (!row) return { state: 'failed', runChatUrl: null };
    return { state: rowState(row), runChatUrl: relayEvidence(row)?.run_chat_url ?? null };
  }

  /** Marks the run cancelled — valid until the run starts. If it is already claimed, throws AlreadyClaimedError. */
  async cancel(runId: string): Promise<void> {
    const row = await this.brain.patchFireRow(runId, { status: 'cancelled', completed_at: iso(this.clock()) }, { statusIn: ['queued'] });
    if (!row) {
      const cur = await this.brain.getFireRow(runId);
      throw new AlreadyClaimedError(cur?.status ?? 'unknown');
    }
  }

  abstract health(): Promise<AdapterHealth>;

  protected async queueStats(): Promise<{ depth: number; lastClaim: string | null }> {
    const rows = await this.brain.listFireRows(this.cto.agentName, ['queued', 'claimed', 'started', 'linked']);
    let lastClaim: string | null = null;
    for (const r of rows) {
      const c = relayEvidence(r)?.claim?.at ?? null;
      if (c && (!lastClaim || c > lastClaim)) lastClaim = c;
    }
    return { depth: rows.filter((r) => r.status === 'queued').length, lastClaim };
  }
}

export function rowState(row: FireRow): RunState {
  const s = row.status ?? '';
  const known: RunState[] = ['queued', 'claimed', 'started', 'linked', 'done', 'closed', 'failed', 'expired', 'refused', 'cancelled'];
  return (known as string[]).includes(s) ? (s as RunState) : 'failed';
}

/** Muse CTO — automatic. The mailbox drain (every 30 minutes) picks up rows addressed to MUSE. */
export class MuseAdapter extends BrainHandoffAdapter {
  protected readonly startStatus: FireStatus = 'started-automatically';

  /** Reachable = the brain answers and the drain can read rows; detail = queue depth + last drain time. */
  async health(): Promise<AdapterHealth> {
    try {
      const { depth, lastClaim } = await this.queueStats();
      return { reachable: true, detail: `queue depth ${depth}; last drain ${lastClaim ?? 'none seen'}` };
    } catch {
      return { reachable: false, detail: 'brain not answering' };
    }
  }
}

/** Claude / Gemini / AXON-Hermes CTO — manual in v1. Muse CTO starts the run by hand. */
export class ManualAdapter extends BrainHandoffAdapter {
  protected readonly startStatus: FireStatus = 'queued-for-person';

  /**
   * Reachable = the Muse program is up (the broker answers — manual programs
   * reach the brain only through it) and the pending manual queue is under its
   * cap of 10 waiting starts; detail = queue depth + last claim time.
   */
  async health(): Promise<AdapterHealth> {
    try {
      await this.brain.ping();
      const { depth, lastClaim } = await this.queueStats();
      return {
        reachable: depth < MANUAL_QUEUE_CAP,
        detail: `queue depth ${depth}/${MANUAL_QUEUE_CAP}; last claim ${lastClaim ?? 'none yet'}`,
      };
    } catch {
      return { reachable: false, detail: 'Muse program (brain broker) not answering' };
    }
  }
}

export function makeAdapter(brain: BrainApi, cto: CtoEntry, clock: Clock): HarnessAdapter {
  return cto.adapter === 'automatic-muse' ? new MuseAdapter(brain, cto, clock) : new ManualAdapter(brain, cto, clock);
}
