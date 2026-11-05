# slack-cto-relay

The Slack CTO Loop relay: four small programs, one per CTO (Muse, Claude,
Gemini, AXON-Hermes). They carry Slack messages between the CTOs, start CTO
work from `/fire-<cto>` commands and `@<CTO> fire: <task>` mentions, and post
the close-out map (Done / Log / Session / Still open) when a run finishes.

Spec: PLAN-v7.md (approved, GO 91.35%). Live facts: RUNBOOK.md (wins where the
two differ).

## Status

- Phase 2, Step 1: brain migration — `supabase/migrations/0001_cto_relay_tables.sql`
  creates `cto_relay_lease` and `cto_heartbeat` in NI Brain
  (project `uaztknnipdxxptrmlxlb`, public schema). Run by hand in the Supabase
  SQL editor. `agent_comms` already exists and is not changed.
- Phase 2, Steps 2–4 (relay code, systemd units, relay runbook): branch
  `phase-2/cto-relay`, merged only through COUNCIL GATE at 95%+.

## Layout

| Path | What |
|---|---|
| `src/` | The relay (TypeScript strict + Zod). `contracts.ts` holds the PLAN-v7 Contracts. |
| `config/registry.json` | CTO registry: the single source for which adapter serves which CTO. |
| `config/blocklist.json` | Post blocklist (canonical copy in the runbook). |
| `supabase/migrations/` | Brain migration (`cto_relay_lease`, `cto_heartbeat`). |
| `deploy/systemd/` | The four relay units, `cto-heartbeat`, and the off-host copy timer. |
| `deploy/scripts/` | Key fetch hook, deploy, mini sync, off-host copy, mini poller and run wrappers. |
| `docs/RELAY-RUNBOOK.md` | Deploy, operate, fail over, rebuild. |
| `test/` | `node:test` suite (in-memory brain + Slack). |

## Checks

```bash
npm ci && npm run check
```
That runs `tsc --noEmit`, the tests, and the key-pattern grep.

## Secrets

No token, key or secret value is ever committed here. Keys live in the Secure
Vault only and are injected at deploy time (tmpfs credentials via the
systemd `ExecStartPre` fetch hook). Code and docs use environment variables
and placeholders such as `<SUPABASE_URL>`.
