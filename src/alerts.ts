// Alerts to Muse CTO (main chat). Transport: an agent_comms row addressed to
// MUSE with code `cto-relay-alert` (drained like other Muse mail), plus a local
// alerts file that is always written — so an alert survives a brain outage.
// Alerts carry machine codes and ids only.

import { join } from 'node:path';
import type { BrainApi } from './brain.js';
import { appendLineCapped } from './util/durable.js';
import type { Logger } from './util/log.js';
import { iso, type Clock } from './util/time.js';

export const ALERT_TO_AGENT = 'MUSE';

export class Alerter {
  readonly path: string;
  private brain: BrainApi | null = null;

  constructor(
    stateDir: string,
    private readonly cto: string,
    private readonly fromAgent: string,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    this.path = join(stateDir, 'alerts.jsonl');
  }

  attachBrain(brain: BrainApi): void {
    this.brain = brain;
  }

  alert(code: string, ids: Record<string, string | number | null> = {}): void {
    const rec = { at: iso(this.clock()), cto: this.cto, code, ...ids };
    try {
      appendLineCapped(this.path, JSON.stringify(rec));
    } catch {
      this.log.error('alert file write failed', { code });
    }
    this.log.warn('alert', { code, ...ids });
    const brain = this.brain;
    if (brain) {
      const subject = `cto-relay alert: ${this.cto}: ${code}`;
      brain.insertAlertRow(ALERT_TO_AGENT, this.fromAgent, subject, JSON.stringify(rec)).catch(() => {
        this.log.warn('alert row write failed; local alert file holds it', { code });
      });
    }
  }
}
