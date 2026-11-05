// Restore, reconciler, the 5-minute row check, expiry, and the 9am pending list.
//
// Restore steps (D6): 1. read the journal. 2. read the brain rows. 3. rebuild
// the queue in journal order. 4. re-post any failed short reply from the brain
// row. 5. call status(runId) on the adapter for each in-flight run and post the
// current state. Each `queued` row gets "still waiting" (D4).
//
// Reconciler (D4, R4-NEW-9/R6-NEW-2): runs on every program start and every 30
// minutes. Reads the journal's fire-request records and the brain rows.
//   - a journal record with no matching brain row is a lost held start → loss
//     notice in the CTO's channel;
//   - a brain row with no journal entry (journal-failure orphan) → marked
//     `failed`, and the requester is told.

import type { RelayCore } from './core.js';
import { CHECKIN_HOUR, MANUAL_CLAIM_LIMIT_MS, MUSE_LINK_WINDOW_MS, ORPHAN_GRACE_MS, START_EXPIRY_MS } from './core.js';
import { NON_TERMINAL_ROW_STATES } from './contracts.js';
import { relayEvidence, type FireRow } from './brain.js';
import type { FireEntry } from './firebook.js';
import { T } from './templates.js';
import { iso } from './util/time.js';

export class Maintenance {
  constructor(private readonly core: RelayCore) {}

  private get d() {
    return this.core.d;
  }

  /** Startup restore (also the failover takeover path). */
  async restore(): Promise<void> {
    const d = this.d;
    // 1–3: the journal is loaded and the queue rebuilt in journal order by the caller (FireBook.load).
    const rows = await d.brain.listFireRows(d.cto.agentName, NON_TERMINAL_ROW_STATES);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const e of d.book.inFlight()) {
      if (e.provisional) continue; // held text was in memory only — the reconciler reports the loss
      const row = rowById.get(e.id) ?? (await d.brain.getFireRow(e.id));
      if (!row) continue;
      // 4: re-post a failed short reply from the brain row's task text.
      if (!e.replyPosted && row.body) {
        const safe = d.poster.safeTask(row.body);
        const text = d.cto.adapter === 'automatic-muse' ? T.startedAutomatically(safe, e.id) : T.queuedForPerson(safe, e.id, d.cto);
        const r = await d.poster.post(e.channelId, text, 'template', e.id);
        if (r.ok) this.core.record({ kind: 'fire-state', fireId: e.id, hash: '', state: 'reply-posted' });
      }
      await this.core.syncFromRow(e, row);
      if (e.terminal) continue;
      // 5: status(runId) for claimed/started rows, "still waiting" for queued rows.
      const st = await d.adapter.status(e.id);
      if (st.state === 'queued') await d.poster.post(e.channelId, T.stillWaiting(e.id), 'template', e.id);
      else await d.poster.post(e.channelId, T.currentState(e.id, st.state), 'template', e.id);
    }
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    const d = this.d;
    const now = d.clock();
    // (a) journal records with no matching brain row
    for (const e of d.book.inFlight()) {
      if (e.provisional) {
        if (e.heldTask === null && !e.lostNotified) await this.lost(e);
        continue;
      }
      let row: FireRow | null;
      try {
        row = await d.brain.getFireRow(e.id);
      } catch {
        return; // brain down: try again next round
      }
      if (!row) {
        if (!e.lostNotified) await this.lost(e);
        continue;
      }
      await this.core.syncFromRow(e, row);
    }
    // (b) brain rows with no journal entry (journal-failure orphans)
    let rows: FireRow[];
    try {
      rows = await d.brain.listFireRows(d.cto.agentName, ['queued', 'claimed', 'started']);
    } catch {
      return;
    }
    for (const row of rows) {
      if (d.book.get(row.id)) continue;
      const fired = Date.parse(row.fired_at ?? row.created_at ?? '');
      if (Number.isFinite(fired) && now - fired < ORPHAN_GRACE_MS) continue; // a write may be in flight
      const ev = relayEvidence(row);
      if (ev && d.journal.all().some((r) => r.idemKey === ev.idem_key && r.kind === 'fire-request')) continue; // provisional mapped elsewhere
      const patched = await d.brain.patchFireRow(row.id, { status: 'failed', completed_at: iso(now) }, { statusIn: ['queued', 'claimed', 'started'] }).catch(() => null);
      if (!patched) continue;
      d.alert('journal-orphan-failed', { fireId: row.id });
      const channel = ev?.slack?.channel_id;
      if (channel && this.core.channels.has(channel)) await d.poster.post(channel, T.orphanFailed(row.id), 'template', row.id);
    }
  }

  private async lost(e: FireEntry): Promise<void> {
    const d = this.d;
    this.core.record({ kind: 'fire-state', fireId: e.id, hash: '', state: 'lost-notified' });
    this.core.record({ kind: 'fire-state', fireId: e.id, hash: '', state: 'failed', reason: 'lost-on-restart' });
    d.alert('start-lost-on-restart', { fireId: e.id });
    if (e.channelId) await d.poster.post(e.channelId, T.lostOnRestart(), 'template', e.id);
  }

  /** Every 5 minutes: the relay checks its own rows (run link, claims, cancels). */
  async pollRows(): Promise<void> {
    const d = this.d;
    for (const e of d.book.inFlight()) {
      if (e.provisional) continue;
      const row = await d.brain.getFireRow(e.id).catch(() => null);
      if (row) await this.core.syncFromRow(e, row);
    }
  }

  /** Every minute: held brain-down retries, link window, claim limit, 24-hour expiry. */
  async timers(): Promise<void> {
    const d = this.d;
    const now = d.clock();
    for (const e of d.book.inFlight()) {
      if (e.provisional) {
        await this.core.retryHeld(e);
        continue;
      }
      const age = now - e.acceptedAt;
      const unclaimed = e.claimAt === null;
      if (unclaimed && age >= START_EXPIRY_MS) {
        const ok = await d.brain.patchFireRow(e.id, { status: 'expired', completed_at: iso(now) }, { statusIn: ['queued'] }).catch(() => null);
        if (ok) {
          this.core.record({ kind: 'fire-state', fireId: e.id, hash: '', state: 'expired', reason: 'unclaimed-24h' });
          d.runlog.write({ kind: 'expiry', fireId: e.id, writer: 'relay', reason: 'unclaimed-24h' });
          await d.poster.post(e.channelId, T.expired(), 'template', e.id);
        }
        continue;
      }
      if (d.cto.adapter === 'automatic-muse') {
        if (!e.linkPosted && age >= MUSE_LINK_WINDOW_MS && !e.noticesSent.has('link-window')) {
          e.noticesSent.add('link-window');
          await d.poster.post(e.channelId, T.linkMissing(e.id), 'template', e.id);
          d.alert('run-link-window-missed', { fireId: e.id });
        }
      } else if (unclaimed && age >= MANUAL_CLAIM_LIMIT_MS && !e.noticesSent.has('still-waiting')) {
        e.noticesSent.add('still-waiting');
        await d.poster.post(e.channelId, T.stillWaitingOnPerson(this.core.nextCheckinLabel()), 'template', e.id);
        if (await this.core.museOnline()) d.alert('manual-start-unclaimed-past-limit', { fireId: e.id });
      }
    }
  }

  /** 9am: the pending list in this CTO's channel (nothing waits invisibly), plus unclaimed-past-limit alerts. */
  async nineAm(): Promise<void> {
    const d = this.d;
    const lines: string[] = [];
    for (const e of d.book.inFlight()) {
      if (e.claimAt !== null) continue;
      let task = e.heldTask;
      if (!task && !e.provisional) task = (await d.brain.getFireRow(e.id).catch(() => null))?.body ?? null;
      lines.push(`${task ? d.poster.safeTask(task) : 'task text unavailable'} — fire id ${e.id}`);
      d.alert('manual-start-unclaimed-at-checkin', { fireId: e.id });
    }
    if (lines.length > 0) await d.poster.post(d.cto.channelId, T.pending(lines), 'template');
  }
}

export { CHECKIN_HOUR };
