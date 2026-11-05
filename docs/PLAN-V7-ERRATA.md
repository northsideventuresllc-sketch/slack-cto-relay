# PLAN-v7 errata — round-7 plan-text items

Source: VERDICT-r7.md (COUNCIL round 7, GO 91.35%). That verdict is authoritative where it differs from PLAN-v7.md.

Some round-7 items are wording fixes to PLAN-v7.md itself: its trace, header, glossary, and the JB-facing summary. PLAN-v7.md is not in this repo, so the replacement text is recorded here for Muse CTO to apply to the plan file. Each item below gives:
- the remedy (from the verdict);
- the exact proposed replacement text;
- what, if anything, the build changed for it.

Items the build fixed in code are listed in the PR body, not here, except where the plan text must also change to match the code.

## Count and citation discrepancies (plan vs verdict)
- **Ship-blocker count in the header.** The PLAN-v7 header says v7 "fixes all 21 round-7 ship-blockers". The verdict found 16 fixed and 5 partial (R7-FU-25).
- **Follow-up count.** PLAN-v7 lists 21 follow-ups (ECO-3, R4-FU-12, R5-FU-1, R5-FU-9, R6-FU-1..16, R3-FU-11). The verdict verifies 20 carried follow-ups (19 fixed, 1 partial) and files **25 new** ones (R7-FU-1..25). The build brief said "25 follow-ups"; that matches the verdict's new list.
- **Verdict cited.** PLAN-v7 cites only `VERDICT-r6.md`. The round-7 findings (R7-NEW-1..7, R7-FU-1..25) come from `VERDICT-r7.md`.
- **New ship-blocker-grade findings.** The verdict files 7 (R7-NEW-1..7). The lens-prefixed and global IDs map one to one.

## Carried partial ship-blockers — plan-text parts
- **KAR-6.** Replace "(a) the adapter's `status(runId)` reports the run as live (not closed/failed/expired) — a live check, distinct from any log timestamp" with:

  > (a) the adapter's `status(runId)` reports the run as live — counted only for an adapter with a real live probe of its harness. No v1 adapter has one: Muse and the three manual adapters read the stored brain row, so prong (a) does not apply in v1, and still-active rests on prongs (b) and (c).

  In the Round 7 notes, drop the "live `status(runId)` check" label. Built: `HarnessAdapter.liveStatus`, `sweep.ts` `assessRun`.
- **R2-NEW-1.** Replace "the new holder reads all non-terminal rows (`queued`, `claimed`, `started`)" with:

  > the new holder reads all non-terminal rows (`queued`, `claimed`, `started`, `linked`; DONE is `linked` plus a claim record)

  Then give the per-state action: `linked` gets `status(runId)`, a current-state post, and its lock is rebuilt. Built: `maintenance.ts` `restore`.
- **R3-NEW-10.** Replace "the 'already running' lock expires 24 hours after the run started, unless a close-out or a run-log entry refreshes it" with:

  > the 'already running' lock expires 24 hours after the last state-changing entry written by the CTO's own adapter (claim, start, link, close-out); expiry is evaluated on read, at every start attempt.

  Built: `firebook.ts` `lockHolder`.
- **R4-NEW-9.** Replace "it is a step in the Muse relay program" with:

  > it is a step in every relay program, run on its own journal (journals are per program).

  Add:

  > When the brain write fails, the program writes a hash-only `fire-request` journal record without a brain row — the stated exception to the fixed write order — and the reconciler reports it lost only when its text is no longer held in memory (a pending hourly retry is never reported lost).

  Built: `core.ts` `holdBrainDown`, `maintenance.ts` `reconcile`.
- **R2-NEW-6.** Delete "the MOA-3 line below cites the `ChannelEvent`/`SlackEvent` definitions in Contracts", or add a real trace line: "MOA-3 → Contracts: `ChannelEvent` and `SlackEvent` are defined there." Add "What JB has to do" to the preamble's re-checked list.
- **R6-FU-11 (partial).** Replace "no occurrence-count claim is made anywhere in this trace" with:

  > the forbidden phrases ("the trace line below", "the one occurrence") do not appear in this trace.

## R7-NEW plan-text parts (the code is fixed; the plan text should match)
- **R7-NEW-1.** Replace "so a silent end is detected within 6 hours" with:

  > so a silent run is flagged by the first sweep after 6 hours of silence (6 to 12 hours after its last activity); the warning is posted to the CTO's channel when flagged, and listed again in the next 9am message.
- **R7-NEW-2.** Use one stalled definition in D5 and §6:

  > Stalled = no activity — no message from that CTO in its channel, and no state-changing entry by its own adapter — for 6 hours. (With no live probe, this is the same as failing the still-active test.)
- **R7-NEW-3.** Add to D6 per-event safety:

  > The 1-hour retry replays the event held in memory; a hash-only `retry-pending` journal marker records that a retry is owed, and if the relay restarts first, the reconciler posts a loss notice in that channel.
- **R7-NEW-4.** In §6 dead-owner fallback, add:

  > The fallback runs a reduced still-active test, prongs (b) and (c) only; prong (a) is skipped. Prong (b) reads the four CTO channels' last 24 hours with the Muse CTO bot token from the mini's `cto-relay-muse` keychain. Prong (c) reads the live brain rows.
- **R7-NEW-5.** In D7, replace the dead-alerter fallback sentence with:

  > If the poller itself is down: the poller writes its own heartbeat row (MINI-POLLER) every minute, the VM Muse program alerts and posts in #cto-bots when it is over 5 minutes old, and Claude CTO's own 9am check-in report shows both heartbeats and every unread mini alert. `alerts.jsonl` is capped at 1 MiB and rotated by rename.
- **R7-NEW-6.** Replace "more than 3 start attempts for the same task in 10 minutes stops starting for that task" with:

  > 3 accepted start attempts for the same task within 10 minutes trip the breaker; the 4th is refused and not recorded.
- **R7-NEW-7.** In Appendix A (e) / D5, add:

  > For Gemini, the session name and Slack thread are filed in the vault log (a `## Session` section), and the map's Session line cites the vault path as the durable copy.

## R7-FU plan-text items
- **R7-FU-1.** D4 brain-down branch: add the sentence quoted under R4-NEW-9 above.
- **R7-FU-2.** Contracts: add `queueDepth: number` and `leaseState` to `HealthResponse`. (Done in `src/contracts.ts`.)
- **R7-FU-3.** Contracts: declare `claimName?`, `windowStart?` and `cto?` as real optional fields on `JournalRecord`. (Done in `src/contracts.ts`.)
- **R7-FU-4.** D6 parsing: add:

  > Only the first-mentioned CTO's program replies "Start one CTO at a time."; the others drop it silently.
- **R7-FU-5.** D5: add a `RunLogEntry` type. "Filled on `linked`" means a new `linked` entry with the same fire id and the session id; nothing is updated in place.
- **R7-FU-6.** D2 post-queue: add:

  > The writer opens the file by path on every write and retries once on ENOENT; the Muse program keeps draining a rotated file for 60 seconds after the rename.
- **R7-FU-7.** D2: add:

  > v1 has one post-queue file, the Muse one; the other three programs have none, and their `message` events feed only abort parsing.
- **R7-FU-8.** Trace R5-NEW-11: replace with:

  > the false '20' figure appears nowhere in the operative text as the cap.

  Trace R6-NEW-1: replace with:

  > the '20' figure survives in the cap arithmetic only as the expected-starts estimate.
- **R7-FU-9.** Cheaper paths, shared-bot cell: replace "plus the same run tokens" with:

  > plus the same run tokens (125,000 tokens a week)
- **R7-FU-10.** Cheaper paths and the payback sentence: replace "repays in 22–36 weeks" with:

  > repays in about 22–36 weeks (21.6–36)
- **R7-FU-11.** D5 mirroring: replace "filed weekly by Muse CTO" with:

  > filed into the vault within a day by the relay host's nightly job; Muse CTO's weekly job is the mirror check.

  (Done in `deploy/scripts/cto-relay-offhost-copy.sh`.)
- **R7-FU-12.** D6 store table: replace "then archived to the vault" with:

  > then archived to the vault at `$VAULT_ARCHIVE_PATH` as `brain-archive-<YYYY-MM>.jsonl` (JSON lines, one row per line), filed nightly; the retrieval test includes the archive.

  (Done in `sweep.ts` `archiveOldRows` and the nightly job.)
- **R7-FU-13.** "What JB has to do": replace "With a re-make of the video, if needed, add 5 minutes: 25 to 29 with a sign-in, 20 to 24 without." with:

  > If the video needs a re-make, add 5 minutes. That makes 25 to 29 minutes with a sign-in, or 20 to 24 without.
- **R7-FU-14.** Glossary additions:
  - "Manual: a person (Muse CTO) starts the work by hand."
  - "Automatic: the work starts on its own, with no person needed."
  - "Check-in: the CTOs' daily 9am chat, where waiting starts are picked up."
- **R7-FU-15.** Glossary: split into "- Run id: the number that names one run." and "- Run link: the link — or, for Gemini, the session name plus thread — that shows the run."
- **R7-FU-16.** JB summary, last sentence: replace with:

  > Each one switches to automatic only after its own live test passes — one real start, done live in Slack, to prove it works.
- **R7-FU-17.** JB summary: use "9am check-in" and add the glossary line from R7-FU-14.
- **R7-FU-18.** JB summary: add four plain lines in JB's order:
  - "When they write: only to ask another CTO, to say a job is done, or to get unblocked."
  - "How they tag: by the real @ name, only the CTO needed."
  - "How they start one: a CTO types /fire-<name> or '@<name> fire: <task>'."
  - "The map: Done / Log / Session / Still open, posted when a job ends."
- **R7-FU-19.** Glossary: "Loop: the round trip — a CTO is started in Slack, does the work, and posts a map to its log back in Slack."
- **R7-FU-20.** Glossary "Start": replace with:

  > Start: to set a CTO working on a task. A CTO starts another CTO in Slack with /fire-<name> or '@<name> fire: <task>'. You never do this — you ask Muse in main chat.
- **R7-FU-21.** Glossary additions:
  - "Vault: the shared notes store where logs are filed for good."
  - "Failover: moving the relay to the mini when this machine is down."
  - "Mini: the small Mac at home that is the backup machine."
- **R7-FU-22.** Replace "after the first checks are done" with:

  > after the first checks are done, later the same day
- **R7-FU-23.** D4 reconciler: add:

  > During a brain outage a restarting program refuses to start, so its reconciler runs once the brain is back and it starts; until then the requester sees no reply from that CTO, and the Muse program (if running) posts '<CTO> relay is down' in #cto-bots.

  (Stated in code and in runbook §11b.)
- **R7-FU-24.** Trace R6-NEW-3: replace "no `'aborted'` literal survives" with:

  > no `'aborted'` state literal survives

  The build uses no `aborted` state anywhere; the relay says "Cancelled".
- **R7-FU-25.** Header: replace "This v7 fixes all 21 round-7 ship-blockers" with:

  > This v7 fully fixes 16 of the 21 round-7 ship-blockers; 5 remain partial and are carried into the build.
