# Slack CTO Loop — Relay Runbook

Owner: Muse CTO. Spec: PLAN-v7.md (D4, D5, D6, D7). Live facts: RUNBOOK.md (wins where the two differ).
This runbook is written so Claude CTO can rebuild the relay alone (Phase 2 solo-rebuild test, 2 hours).

**Secrets rule.** No key, token or secret value goes in this repo, in a chat, in a log, or in the proof pack. Keys live in the Secure Vault only. They are fetched at start into tmpfs. Every `<ANGLE_BRACKET>` value below is a placeholder you fill on the host.

---

## 1. What runs where

| Program | systemd unit | Service user | Health port | Keys it holds |
|---|---|---|---|---|
| Muse CTO relay | `cto-relay-muse.service` | `cto-relay-muse` | 9101 | Muse app token, Muse bot token, brain key `cto-relay-muse` |
| Claude CTO relay | `cto-relay-claude.service` | `cto-relay-claude` | 9102 | Claude app token, Claude bot token |
| Gemini CTO relay | `cto-relay-gemini.service` | `cto-relay-gemini` | 9103 | Gemini app token, Gemini bot token |
| AXON-Hermes CTO relay | `cto-relay-axon-hermes.service` | `cto-relay-axon-hermes` | 9104 | AXON-Hermes app token, AXON-Hermes bot token |

- **Health:** each program answers `GET /health` on `127.0.0.1:<port>` and on the VM LAN address `198.19.0.2:<port>` (RUNBOOK Phase 0 close-out). Only this machine and the mini can open it.
- **Code:** `/opt/cto-relay`. Node 22+. The command is `/usr/local/bin/cto-relay`.
- **State:** `/var/lib/cto-relay/<cto>/` (mode 0700, durable disk). It holds:
  - `journal.jsonl`: the start journal. Append-only, fsynced, hashes only.
  - `run-log.jsonl`: ids and hashes only, kept 90 days.
  - `audit.jsonl`: redacted text of 80 characters or less, kept 90 days.
  - `quarantine.jsonl`: event id, text hash and reason, kept 7 days.
  - `outbox/`: close-out maps waiting on vault read-back.
  - `alerts.jsonl`: the local copy of every alert. It is capped at 1 MiB and rotated by rename (`.1`–`.3`), never truncated.
  - `vault/`: this program's checkout of the vault.
  - Muse only: `post-queue.jsonl`, `mirror/` and `archive/`.
- **Post-queue file layout (R7-FU-7):** v1 has exactly one post-queue file, `/var/lib/cto-relay/muse/post-queue.jsonl`. The Claude, Gemini and AXON-Hermes programs have none. Off-VM CTOs cannot write to this VM, so their words go through Muse CTO into the Muse file (D2). Their programs' `message` events feed only abort parsing.
- **Keys:** `/run/credentials/cto-relay-<cto>/`. This is tmpfs (dir 0500, files 0400, owner = the service user). It is rewritten on every start and wiped on stop.
- **Sockets:**
  - `/run/cto-relay/<cto>/control.sock` (group `cto-relay-admin`).
  - `/run/cto-relay/broker/<cto>.sock` (group `cto-relay-<cto>`; manual CTOs only).
- **Brain tables touched, and only these:**
  - `agent_comms`: existing; 15 real columns, no `payload` and no `updated_at`.
  - `cto_relay_lease` and `cto_heartbeat`: created by `supabase/migrations/0001_cto_relay_tables.sql`.

### Why only Muse holds the brain key — the brain broker
D7 says the Claude, Gemini and AXON-Hermes programs fetch only their two Slack keys. But every program writes brain rows and holds a lease. So the Muse program serves one Unix socket per manual CTO. The other three make their brain calls through it. Each socket is scoped to its own CTO:
- its own `agent_comms` rows only (by `to_agent`);
- its own lease name only;
- alerts to MUSE only;
- heartbeat read-only.

D4's manual `health()` rule ("reachable means the Muse program is up") follows from this. If the Muse program is down, the other three refuse to start (fail-closed) until it is back.

### Exit codes
- `0`: stopped cleanly.
- `1`: retry. systemd restarts it every 30 s. Causes: brain down at start, lease held by another live holder, health bind failed.
- `78`: stay down (`RestartPreventExitStatus=78`). Causes: Slack token revoked or invalid, Socket Mode reconnects exhausted (1/2/4/8/16 s), config placeholders unset, wrong bot token. An alert is written first.

---

## 2. Before the first deploy (checklist)

Fill these in. Do not guess them. Every value below either has its real value here, or a named source to read it from. `deploy.sh` lists any line still holding a `<PLACEHOLDER>` in any case (C2-FU-11), and the services refuse to start while one remains.

1. **Phase 3 Slack work** (C2-FU-7):
   - **Four private CTO channels.** Create them and put their ids into `config/registry.json` in place of `<CTO_*_CHANNEL_ID>`. A program refuses to start while any channel id is a placeholder (the refusal names `config/registry.json`).
   - **Event subscriptions, on each of the four apps** (Event Subscriptions → Subscribe to bot events): `app_mention`, `message.channels`, `message.groups`. Without them the relay sees no starts; the Phase 5 ingress test catches it.
   - **Slash commands, one per app, in Socket Mode** (Slash Commands): `/fire-muse`, `/fire-claude`, `/fire-gemini`, `/fire-axon-hermes`. Check each name is free first (dashboard list; fallback names in D4). The `commands` scope is already granted (Phase 1, 10 scopes each).
2. **Agent names — set** (COUNCIL GATE round 1). `config/registry.json` carries:
   - `MUSE`: verified from a live row;
   - `Claude CTO`: confirmed by JB (live rows carry it; PLAN-v7 D7 wrote `CLAUDE`);
   - `Gemini CTO`: seen in live rows;
   - `AXON-Hermes CTO`: matches the Slack bot name.

   Before the first deploy, check `AXON-Hermes CTO` against a live `agent_comms` row or the harness roster. A wrong name fails loudly at the broker's `toAgent` match.
3. **`/etc/cto-relay/fetch-keys.conf` — `VAULT_GET`** (C2-FU-1).
   - **The interface is fixed.** One argument (the vault label). It reads the machine token from the file in `$VAULT_TOKEN_FILE` (`/etc/cto-relay/vault-token`) and prints only the value on stdout.
   - **The concrete command string is TO RECORD.** It is not in PLAN-v7, the setup RUNBOOK, or this repo, and no Secure Vault CLI exists in the workspace to check one against, so it is not guessed here.
   - **Procedure:**
     1. Muse CTO creates the `vault-cli-machine` machine token in the Secure Vault web UI (D7 hook bootstrap).
     2. `sudo deploy/scripts/deploy.sh --vault-token-stdin` writes it to `/etc/cto-relay/vault-token` (mode 0400, owner root).
     3. Muse CTO records the Secure Vault's CLI fetch command in `VAULT_GET`.
     4. Check it by hand once: `sudo VAULT_TOKEN_FILE=/etc/cto-relay/vault-token <command> cto-relay-muse > /dev/null && echo ok`. Never print the value.

     The fetch hook refuses to run (exit 78) while `VAULT_GET` is a placeholder.
4. **Slack token labels — named** (C2-FU-4). Store each token in the Secure Vault under these labels (already in `fetch-keys.conf.example`):

   | Label | Value comes from (each app's settings page, api.slack.com/apps) |
   |---|---|
   | `cto-relay-<cto>-slack-app` | Basic Information → App-Level Tokens → "<App name> Socket Token" (`connections:write`) |
   | `cto-relay-<cto>-slack-bot` | OAuth & Permissions → Bot User OAuth Token |

   `<cto>` is one of `muse`, `claude`, `gemini`, `axon-hermes`. The brain key label is `cto-relay-muse` (stored, Phase 1).
5. **Vault deploy keys — named** (C2-FU-2, C2-FU-3). Owner: Muse CTO. Both are created on the vault repo, GitHub → Settings → Deploy keys.

   | Label | Type | Used by | How it reaches the host |
   |---|---|---|---|
   | `cto-relay-vault-read` | read-only deploy key (one key, shared by the four programs) | close-out read-back (`git fetch`, `git show origin/main:<path>`) | fetched into each program's tmpfs as `vault-read-key` on every start |
   | `cto-relay-vault-write` | deploy key with **Allow write access** | the nightly job: checksums, mirror, brain archive into the vault | fetched into `/run/credentials/cto-relay-offhost/` by the off-host unit's ExecStartPre |

   **Vault repo:** `git@github.com:northsideventuresllc-sketch/nv-vault.git`, taken from PLAN-v7 Appendix A's Log link. **Verify before first deploy.** Each checkout is cloned automatically on first use.

   **GitHub host keys:** `deploy.sh` pins them in `/etc/cto-relay/known_hosts`. Check the printed fingerprints against GitHub's published "SSH key fingerprints" page.
6. **`/etc/cto-relay/relay.env`:**
   - `SUPABASE_URL=<SUPABASE_URL>`: the NI Brain REST base for project `uaztknnipdxxptrmlxlb`. Read it from the Supabase dashboard → Project Settings → API.
   - `CTO_RELAY_VAULT_WEB_BASE` and `CTO_RELAY_VAULT_REPO_URL` are prefilled from Appendix A; verify them.
7. **`/etc/cto-relay/offhost.env`:**
   - `VAULT_MIRROR_PATH` = `_AI/CTO Loop/Mirror` and `VAULT_ARCHIVE_PATH` = `_AI/CTO Loop/Brain Archive` (C1-FU-2). These are new folders for the loop; Muse CTO may rename them.
   - `MINI_SSH_DEST` = `<user>@<name>.local`. Read it on the mini (C1-FU-3): run `whoami` as the copy user, and `scutil --get LocalHostName`.
8. Fill `<MUSE_CTO_USER>` in `deploy/sudoers/cto-relay` with the login of Muse CTO's main-chat user on this VM.

---

## 3. Deploy steps (VM)

```bash
sudo git clone https://github.com/northsideventuresllc-sketch/slack-cto-relay /srv/cto-relay-src
```
```bash
cd /srv/cto-relay-src && sudo git checkout <COMMIT>
```
Write the machine token from stdin. Paste it into the prompt; never put it on the command line:
```bash
sudo deploy/scripts/deploy.sh --vault-token-stdin
```
The deploy script does the following:
1. Creates the users and groups: `cto-relay-{muse,claude,gemini,axon-hermes}` and `cto-relay-admin`.
2. Builds the code into `/opt/cto-relay`.
3. Installs the four units, `cto-heartbeat.{service,timer}`, `cto-relay-offhost-copy.{service,timer}`, `/etc/tmpfiles.d/cto-relay.conf`, the fetch hook, and the sudoers rule.
4. Prints the commit and config hash.

Then:

1. **Update `cto-relay-expected.json` in the vault** with the printed `{commit, configHash}`. Every deploy must do this; the mini sync checks it.
2. Add Muse CTO's main-chat user to `cto-relay-admin` (control sockets):
   ```bash
   sudo usermod -a -G cto-relay-admin <MUSE_CTO_USER>
   ```
3. There is no manual vault clone. Each program clones `CTO_RELAY_VAULT_REPO_URL` into `/var/lib/cto-relay/<cto>/vault` on its first close-out read-back, with the read-only key (§2.5). The nightly job clones the filing checkout with the write key.
4. Start everything:
   ```bash
   sudo systemctl enable --now cto-heartbeat.timer cto-relay-offhost-copy.timer
   ```
   ```bash
   sudo systemctl enable --now cto-relay-muse
   ```
   ```bash
   sudo systemctl enable --now cto-relay-claude cto-relay-gemini cto-relay-axon-hermes
   ```
5. Check each program:
   ```bash
   for p in 9101 9102 9103 9104; do curl -s http://127.0.0.1:$p/health; echo; done
   ```
   ```bash
   for p in 9101 9102 9103 9104; do curl -s -o /dev/null -w "%{http_code}\n" http://198.19.0.2:$p/health; done
   ```
   Each must show `"ok":true`, `lease.state":"held"`, latency numbers, and `adapter`.
6. Run the membership check (D1) on all five channels: zero humans and zero non-CTO bots.

### Startup order inside one program (fail-closed)
1. Config: refuse if placeholders remain.
2. Keys from tmpfs.
3. Brain ping. Muse calls the brain directly; the others go through the broker. No brain means refuse to start.
4. Muse only: start the broker.
5. Lease: acquire with epoch+1. If it is held by another live holder, refuse.
6. Journal load and queue rebuild.
7. Slack `auth.test`. A bad token fails closed for this CTO only.
8. Health bind on localhost and the LAN address.
9. Control socket.
10. Restore and reconciler.
11. Socket Mode.
12. Timers.

---

## 4. The four systemd service files

They live in `deploy/systemd/`: `cto-relay-muse.service`, `cto-relay-claude.service`, `cto-relay-gemini.service`, `cto-relay-axon-hermes.service`. All four share one shape. They differ only in these ways:
- the CTO name, user and paths;
- Muse's `SupplementaryGroups` (it hands each broker socket to that CTO's group);
- the other three have `After=`/`Wants=cto-relay-muse.service`, because they reach the brain through Muse.

What every unit sets:
- `User=`/`Group=` set to the per-CTO service user.
- `ExecStartPre=+/usr/local/bin/cto-relay-fetch-keys <cto>`: a fresh vault fetch on every start, run as root.
- `ExecStopPost=+/usr/local/bin/cto-relay-fetch-keys --wipe <cto>`: wipes the tmpfs keys.
- `Environment=CTO_RELAY_KEY_DIR=/run/credentials/cto-relay-<cto>`.
- `StateDirectory=cto-relay/<cto>` with mode 0700.
- `MemoryMax=128M` and `CPUQuota=25%` (D6 isolation envelope).
- `Restart=on-failure`, `RestartSec=30`, `RestartPreventExitStatus=78`.
- Hardening: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, an empty `CapabilityBoundingSet`, and `ReadWritePaths` limited to its own state dir and `/run/cto-relay`.

Read `deploy/systemd/cto-relay-muse.service` for the full text.

---

## 5. Keys — tmpfs injection and the ExecStartPre fetch (D7)

### Labels
Labels only; never values.

| File in tmpfs | Who | Vault label |
|---|---|---|
| `slack-app-token` | each program | `cto-relay-<cto>-slack-app` (Socket Mode, `connections:write`) |
| `slack-bot-token` | each program | `cto-relay-<cto>-slack-bot` (10 bot scopes incl. `commands`) |
| `brain-key` | Muse program + `cto-heartbeat` | `cto-relay-muse` |
| `vault-read-key` | each program | `cto-relay-vault-read` (read-only vault deploy key) |
| `vault-write-key` | the nightly off-host job only | `cto-relay-vault-write` (vault deploy key with write access) |

### Hook
`/usr/local/bin/cto-relay-fetch-keys <cto>` does the following:
1. It refuses unless `/run` is tmpfs.
2. It reads the machine token file `/etc/cto-relay/vault-token` (0400 root; label `vault-cli-machine`).
3. It calls `VAULT_GET <label>` per file, writing straight to a new tmpfs dir with umask 0277.
4. It hands the dir to the service user (dir 0500, files 0400) and swaps it into place.

Values never touch argv, logs, or disk outside tmpfs.

### Read order
The running process reads the keys from the tmpfs files that ExecStartPre wrote on this start. The deploy-time write is only the initial seed of the machine token. When the vault has a rotated key and tmpfs is stale, the fresh fetch overwrites tmpfs before the process starts. So the fresh fetch always wins.

> **Deviation from the plan text (COUNCIL GATE item).** D7 names `LoadCredential=brain-key:/run/credentials/cto-relay-muse/brain-key` as the hand-off. systemd loads `LoadCredential=` sources once, at unit start, before any `ExecStartPre=` runs. So a key the hook fetched could not reach the process on the same start, which breaks D7's own "fresh fetch wins" rule. The units therefore pass the hook's tmpfs dir to the process directly (`CTO_RELAY_KEY_DIR`). The tmpfs location, modes, the per-start fetch, and "fresh fetch wins" are all kept. If `$CREDENTIALS_DIRECTORY` is set and `CTO_RELAY_KEY_DIR` is not, the code falls back to it.

### Rotation
**Brain key, every 90 days:**
1. Create a new key in the NI Brain dashboard.
2. Put it into the Secure Vault under `cto-relay-muse`.
3. Run:
   ```bash
   sudo systemctl restart cto-relay-muse cto-heartbeat
   ```
4. Copy the new key into the mini's `cto-relay-muse` keychain.

**`vault-cli-machine`, every 180 days:**
1. Create a new token in the vault UI.
2. Run:
   ```bash
   sudo deploy/scripts/deploy.sh --vault-token-stdin
   ```
3. Restart all four services.

**A lost key is rotated, never recovered.**

### Revocation test (Phase 2 exit)
1. Revoke one CTO's bot token in Slack, for example Claude.
2. Within about a minute:
   - `cto-relay-claude` exits 78 and stays down.
   - The alert reaches Muse CTO: an `agent_comms` row to MUSE with code `cto-relay-alert`, plus `alerts.jsonl`.
   - After 3 failed health polls, the Muse program posts "Claude CTO relay is down. Starts for Claude CTO are paused. Muse CTO has been told." in #cto-bots. That is the visible failure.
   - The other three keep working.
3. Restore: new token into the vault, then:
   ```bash
   sudo systemctl restart cto-relay-claude
   ```
   The Muse program posts "Claude CTO relay is back."

---

## 6. Muse CTO operations

### Starting a CTO for JB (D4 "the one route for JB")
JB asks in main chat. Muse CTO appends a `fire` entry to the post-queue as `cto-relay-muse` (the file is owner `cto-relay-muse`, mode 0600):
```bash
sudo -u cto-relay-muse /usr/local/bin/cto-relay post-queue-append --kind fire --cto claude --task "Build the Match Fit email groups"
```
- **For Muse:** the Muse program feeds its own fire path; it is Muse's single parser.
- **For another CTO:** the Muse program posts `@<CTO> fire: <task>` as the Muse CTO bot in that CTO's channel. Only that CTO's program receives the `app_mention`, so exactly one run starts there.

### Posting Muse CTO's own words (an ordinary post that can never start work)
```bash
sudo -u cto-relay-muse /usr/local/bin/cto-relay post-queue-append --kind post --channel cto-bots --text "@Claude CTO — Need your call on the Match Fit email groups before we send."
```
- Channels: `cto-bots`, `cto-muse`, `cto-claude`, `cto-gemini`, `cto-axon-hermes`.
- The poster turns plain names into real mentions. It strips any mention + `fire:` + task. It blocks the whole post on any blocklist hit; the block is logged and never posted.
- The post-queue rotates weekly or at 10 MB, by rename + create new. Rotated files are kept 7 days.

### The manual state machine (Claude, Gemini, AXON-Hermes) — control commands
Run as a member of `cto-relay-admin`:
```bash
cto-relay admin claim   --cto claude --fire-id <FIRE_ID> --name "Muse CTO"
```
```bash
cto-relay admin start   --cto claude --fire-id <FIRE_ID>
```
```bash
cto-relay admin link    --cto claude --fire-id <FIRE_ID> --link "<run link in the D4 per-CTO form>"
```
```bash
cto-relay admin closeout --cto claude --fire-id <FIRE_ID> --vault-log-path "<path in vault>.md" --tokens <N> --minutes <N>
```
```bash
cto-relay admin stopped --cto claude --fire-id <FIRE_ID>
```
```bash
cto-relay admin review-clear --cto claude
```
- `claim` is Muse CTO's pre-start check. The program refuses the claim if an abort was journaled first (`abort-won`), if the fire is already claimed, or if another run of the same task is claimed (`duplicate-run`). Start the work only after `claim` returns `ok`.
- `stopped` is used after a stop request: an abort that came after the claim.
- `review-clear` is the Monday review. It clears an overrun block.
- Gemini's "link" is the mini session name plus the Slack thread, as free text.
- `--tokens` is omitted when the harness gives no count; the close-out then records "unmetered".
- Status values written into the brain row: the relay writes `queued`, `linked`, `closed`, `failed`, `expired`, `refused`, `cancelled`; Muse CTO writes `claimed` and `started` through the commands.

### When a start fails before it reaches the adapter (R7-NEW-3)
1. The program retries the event in-process: 5 attempts with the 1/2/4/8 s backoff.
2. After 5 failed attempts, a start-pattern event is never quarantined. It gets:
   - the reply "Could not start this. Muse CTO has been told. One more try in 1 hour.";
   - an alert;
   - one retry an hour later.
3. **Where the retry's content comes from:** the event itself, held **in memory** for that hour. Quarantine, the journal and the run log hold no text.
4. A hash-only journal marker (`retry-pending`, with the channel id) records that a retry is owed.
5. If the relay restarts inside that hour, the reconciler finds the unmatched marker. It posts "A start waiting for its one retry was lost when the relay restarted. Please re-send it." in that channel.

### Muse automatic — the mailbox drain contract
The drain is outside this repo (C2-FU-6):
- **Owner:** Muse CTO, as part of its main-chat harness (the MUSE mailbox drain).
- **Host:** this VM, the same host as the relay and the `cto-heartbeat` cron.
- **Schedule:** every **30 minutes** (D4). That is the Muse fire-to-start time, and the relay's 35-minute link window is sized to it.
- **Run link form:** `https://muse.ai/chat/<run-id>`, the form PLAN-v7 D4 names. The Phase 1 record has no live check of it, so **verify it on the first Phase 5 Muse start.** The relay posts whatever URL the drain writes; it never builds the link itself.

It must follow these rules:
- **Pick up only** `agent_comms` rows with `code = 'cto-relay-fire'`, `to_agent = 'MUSE'`, `status = 'queued'`.
- **Skip** `refused` and `cancelled` rows.
- **Before picking a row up, check journal presence:**
  ```bash
  cto-relay admin journal-has --cto muse --fire-id <ROW_ID>
  ```
  `{"has":false}` means skip. The reconciler marks such a row `failed` and tells the requester.
- **On pickup:** set `status` to `claimed`, then `started`. Write the run link into `evidence.relay.run_chat_url`. Do the update read-modify-write, guarded by `evidence.relay.v`, and bump `v` by 1.
- **What the relay does next:** it checks its rows every 5 minutes and posts `Run: <link>` when the link appears. With no link 35 minutes after the start, it posts a visible failure and alerts.
- Rows with `code = 'cto-relay-alert'` are alerts to Muse CTO, not starts.

### What each start writes to `agent_comms` (real columns only)
| Column | Value |
|---|---|
| `to_agent` | the CTO's agent name from the registry (`MUSE`, `Claude CTO`, `Gemini CTO`, `AXON-Hermes CTO`) |
| `from_agent` | the requesting CTO bot's agent name |
| `from_harness` / `to_harness` | `cto-relay` / the CTO key |
| `channel` | `slack` |
| `subject` | `Start for <CTO>` |
| `body` | the task text. The brain row is the content record, kept 90 days, then archived to the vault. |
| `status` | `queued` → … |
| `fired_at` / `completed_at` | timestamps |
| `evidence` | `{relay:{v, cto, task_hash, norm_hash, idem_key, epoch, slack{channel_id,ts,permalink}, run_chat_url, link_posted_at, last_progress_at, claim, lock_cleared, closeout}}` |
| `code` | `cto-relay-fire` |
| `parent_id` | unused |
| `id` | the fire id quoted in the short reply, and the run id |

---

## 7. Close-out (D5)

1. The CTO files a session log in the vault apartments.
   - It must have `## Decided`, `## Why`, `## What failed`, `## Reusable`, and `## Open items` (each item with `Owner: <name>`).
   - **Gemini, or any Session pointer that is not a link (R7-NEW-7):** add a `## Session` section that carries the pointer word for word, for example `mini session gem-42 + Slack thread`. Slack history goes after a year, so the vault log is the durable copy. The relay refuses to post the map until the read-back log contains it. The map's Session line then reads `<pointer> (filed in the log: <vault path>)`.
   - Put a `.sha256` sidecar next to it, holding the hex SHA-256 of the file's bytes (`sha256sum` output is fine).
   - Commit and push.
2. Muse CTO runs `cto-relay admin closeout …` for that CTO.
3. The program fetches the vault and reads the file back from `origin/main`. It hashes the bytes and compares the hash to the sidecar. Only on a match does it post:
   - The map in the CTO's own channel:
     ```
     Done: <first Decided line, 20 words or fewer>
     Log: <link>
     Session: <run link>
     Still open: <Open items | None>
     ```
     followed by the four tags.
   - The pointer in #cto-bots: `Close-out: <outcome>. Map is here: <map message link>` plus the four tags.
4. **No read-back means nothing is posted.** The map waits in `outbox/`. Retries run every 5 min × 12, then hourly × 24, TTL 7 days, and Muse CTO is alerted. A corrupt outbox entry is rebuilt from the journal plus the brain row's close-out request.
5. On a successful post, the program:
   - writes the journal `closed` record (close-out key, kept 90 days);
   - sets the row to `closed`;
   - writes the cost line (CTO, task hash, home, tokens, minutes);
   - flags an overrun if tokens are over 25,000. The next start for that CTO is then refused until `review-clear`.
6. A map link that does not open is not done. Muse CTO re-issues it within a day and logs the re-issue.

---

## 8. Health, the mini poller, and failover

### Mini poller
It is a 1-minute cron on the mini:
```
* * * * * /opt/cto-relay/deploy/scripts/mini-poller.sh
```
It runs as user `cto-relay-muse`. The secrets come from that user's keychain and reach the poller on stdin only.
- **What it checks:** it curls `http://198.19.0.2:9101..9104/health` and reads the `cto_heartbeat` row for MUSE.
- **Offline:** the heartbeat is older than 30 min, or the brain is down (fail-safe).
- **Alert at 45 min:** an `agent_comms` row to `Claude CTO`. If the brain is down, it writes `/var/lib/cto-relay/mini/alerts.jsonl` instead, which Claude CTO reads at the morning check-in.
- **Failover detected:** the VM Muse health fails 3 consecutive polls AND Muse CTO is offline. The poller sends the failover row to `Claude CTO` once.
- **Dead-owner sweep (R7-NEW-4):** while the Muse program is down, the poller runs the D5 §6 sweep every 6 h with the **reduced** still-active test: prongs (b) + (c) only. Prong (a) is skipped, because the mini has no adapter to probe and no v1 adapter has a live probe anyway.
  - (b) reads the last 24 h of Slack history in the four CTO channels from `config/registry.json`. It uses the Muse CTO bot token (`channels:history` / `groups:history`) from the `cto-relay-muse` login keychain, keychain item `cto-relay-muse-slack-bot`.

**Mini keychain items** (C1-FU-3) are created at failover setup in each `cto-relay-<cto>` macOS user's login keychain, with the same names as the vault labels: `cto-relay-<cto>-slack-app`, `cto-relay-<cto>-slack-bot`, and, Muse only, `cto-relay-muse` (the brain key).
  - (c) reads `evidence.relay.last_progress_at` from the **live** brain rows, not from the up-to-24-hours-stale off-host run-log copy.
  - Findings go to `Claude CTO`, labelled "reduced test: prongs b+c". The fallback never posts in Slack.
- **The poller's own liveness (R7-NEW-5):** every run writes a `cto_heartbeat` row for agent `MINI-POLLER`. The VM Muse program checks it every minute. If it is stale for over 5 min, it alerts and posts "The mini poller has stopped answering…" in #cto-bots, once per incident, then "The mini poller is back." on recovery.

### The dead-alerter fallback — Claude CTO's 9am check-in (R7-NEW-5)
**Who notices.** An offline Muse CTO cannot notice its own stale heartbeat. So the noticer is **Claude CTO, at its own daily 9am check-in**.

**What it runs**, on the mini as `cto-relay-muse` (directly, or `ssh <MINI_SSH_DEST> …`):
```bash
/opt/cto-relay/deploy/scripts/mini-checkin.sh
```

**What it shows:**
- Muse CTO's heartbeat age (OFFLINE past 30 min, so take the manual starts);
- the mini poller's heartbeat age (POLLER DOWN past 5 min, so restart its cron);
- every alert in `/var/lib/cto-relay/mini/alerts.jsonl` not yet shown.

The report records its read position, so each alert is shown once. `alerts.jsonl` is capped at 1 MiB and rotated by rename, keeping 3 old files.

**If the VM Muse program AND the poller are both down,** this report is where it shows: both heartbeats are stale.

### Failover (RTO 15 minutes)
1. **Verify the mini.** On the mini, run the checked step:
   ```bash
   /opt/cto-relay/deploy/scripts/cto-relay-mini-sync.sh
   ```
   It compares the mini's repo commit + config hash with `cto-relay-expected.json` in the vault and checks the off-host journal copies.
   - `ABORT` means stop and fix the mini; the mini is behind or different.
   - `PROCEED` means go on.
2. **Make sure the VM programs are stopped,** if the VM is reachable:
   ```bash
   sudo systemctl stop cto-relay-muse cto-relay-claude cto-relay-gemini cto-relay-axon-hermes
   ```
3. **Start the mini relays:**
   ```bash
   /opt/cto-relay/deploy/scripts/cto-relay-mini-sync.sh --start
   ```
   Each program acquires its lease with epoch+1 once the VM lease has expired (90 s). The old holder's epoch is then stale: it can neither fire nor post.
4. **Takeover restore** runs automatically:
   - The journal comes from the off-host copy.
   - Queue content comes from the brain rows.
   - Each `queued` row gets "still waiting".
   - Each `claimed`/`started` row gets its current state.
   - Journal-orphan rows are marked `failed`.
5. **Hand back.** Stop the mini relays (`launchctl bootout system/com.northside.cto-relay.<cto>`), then start the VM services. They acquire epoch+1.
6. **Prove one live program per CTO:** exactly one `lease.state":"held"` per CTO across VM and mini.

### Mini isolation
Each program runs as its own macOS user (`cto-relay-<cto>`) with its own login keychain. If macOS users cannot be created, use per-CTO keychains with ACLs and **record that here**; never silently.

---

## 9. Off-host copy, hygiene, restore drill

- **Nightly** (`cto-relay-offhost-copy.timer`, 02:30):
  1. Copies each program's `journal.jsonl` and `run-log.jsonl` to the mini, with per-file `.sha256`.
  2. Writes `backups/<date>.sha256` into the vault.
  3. Verifies checksum + record count on the mini.
  4. **Copy vs brain (R5-FU-9):** `cto-relay copy-check` hands each copy's fire ids to the Muse program. It posts a gap in #cto-bots when a brain row fired 1–23 h ago has no journal record in the copy.
  5. **Files the mirror and the brain-row archive into the vault within a day** (R7-FU-11, R7-FU-12): `muse/mirror/` goes to `$VAULT_MIRROR_PATH`, and `muse/archive/brain-archive-<YYYY-MM>.jsonl` goes to `$VAULT_ARCHIVE_PATH`. The archive is JSON lines, one full `agent_comms` row per line.
  6. Commits and pushes.

  On any failure it writes a capped alert for the 9am check-in.
- **Mirror (R7-FU-11):** the relay host files it within a day, through the job above. Muse CTO's weekly job is the mirror **check** (thread links + a secrets sample), not the filing.
- **Retrieval test:** include the archive folder (`$VAULT_ARCHIVE_PATH`) in the vault search, so starts older than 90 days stay findable (R7-FU-12).
- **Restore drill**, monthly (first Monday):
  1. On a scratch host or the mini, place a copy's `journal.jsonl` into an empty state dir.
  2. Start that program with `CTO_RELAY_HOLDER=drill` against a **stopped** VM program.
  3. Confirm it restores the queue and posts the restore states.
  4. Stop it, and hand back.

---

## 10. Blocklist (canonical copy — must match `config/blocklist.json`)

Owner: Muse CTO. Reviewed monthly.

**Key patterns:**
- `xox[baprs]-…`
- `xapp-…`
- `sk-` followed by 20 or more characters
- `sb_secret_…`
- JWT-shaped strings
- private-key headers

**Personal data:**
- email addresses
- `NNN-NN-NNNN`
- 13–19 digit runs

**JB's private matters:**
- `home/street/mailing/postal address`
- `phone:` / phone-number shapes
- `health|medical|diagnos…|prescription|therapy`
- money amounts (`$1,200`)

**What a hit does:**
- **Post-queue text (CTO words):** the whole post is blocked and logged, never posted.
- **Relay templates that carry task text:** the task part is redacted, so the 3-second reply still goes out.
- **Audit snippets and mirror entries:** redacted.

Coordination notes (strategy discussion, open items, decisions) are not blocked.

---

## 11. Scheduled duties

| When | What | Who |
|---|---|---|
| Every minute | held brain-down retries, link window (Muse 35 min), claim limit (manual 30 min), 24 h expiry, outbox retries; Muse: sibling watch | each program |
| Every 5 min | own brain rows: claims, starts, run links, cancels, lock clears | each program |
| Every 30 min | reconciler (lost starts, journal orphans) | each program |
| Every minute | mini poller heartbeat watch (`MINI-POLLER`, stale over 5 min) | Muse program |
| Every 6 h | close-out sweep. A run silent 6 h is flagged by the **first sweep after** 6 h of silence, so 6–12 h after its last activity (R7-NEW-1). The stalled warning is posted to the CTO's channel at once and listed again at 9am. Unclosed means over 24 h. | Muse program |
| 9:00 local | pending starts in each CTO channel; Muse: clear stalled locks, sweep, daily open in #cto-bots | each program / Muse |
| 03:00 local | journal compaction (dedup entries > 24 h, close-out keys > 90 days), run-log/audit/quarantine retention | each program |
| Every 15 min | `cto-heartbeat` | VM timer |
| Monday | weekly cost line (fired-run tokens + review tokens ≤ 50,000), meter check, mirror check, membership audit, quarantine review, `review-clear` if due | Muse CTO |
| Weekly | file `mirror/cto-loop-mirror-<Monday>.md` into the vault | Muse CTO |
| First Monday | Slack export test, restore drill | Muse CTO |

---

## 11a. The still-active test and "stalled" — one definition (KAR-6, R7-NEW-2)

A run is **still active** if any of these holds:
- **(a)** The adapter's `status(runId)` reports it live. This counts **only for an adapter with a real live probe** (`liveStatus: true`). **No v1 adapter has one.** Muse and the three manual adapters all read the stored brain row, so in v1 prong (a) does not apply.
- **(b)** The CTO's channel has a message from that CTO in the last 6 h. Relay templates do not count.
- **(c)** The run is under way (`claimed`/`started`/`linked`) and its last state-changing entry by the CTO's own adapter is under 6 h old.

**Stalled** means not still active, which in v1 means no (b) and no (c) activity for 6 h. D5's "fails all three for 6 hours" and §6's "no activity for 6 hours" are the same test here.

**Unclosed** means stalled with the last activity over 24 h old.

## 11b. Brain outage — what the requester sees (R7-FU-23)
- **The first 90 s of an outage:** starts are held in memory. The requester gets "Queued. Brain is down. Will retry." (Muse) or "Waiting. It will start at the next check-in…" (manual).
- **After 3 missed lease heartbeats (90 s):** a running program stops firing and posting (lease rule). New starts in that time get **no reply**. **COUNCIL GATE flag:** the plan's brain-down reply path only covers outages shorter than 90 s.
- **A program that restarts during the outage** cannot reach the brain, so it refuses to start (fail-closed). Its restore and reconciler run once the brain is back and it starts; loss notices arrive then. Meanwhile, if the Muse program is still up, it posts "<CTO> relay is down" in #cto-bots after 3 failed health polls.

## 11c. The 3-second reply bound (C2-FU-9)
- The brain work before a short reply runs inside a **2.2 s budget from socket receipt**. That work is the three cap counts and the live lease read, run concurrently, then the brain-row write.
- If the brain answers too slowly for the budget, the start is held exactly like a brain-down start ("Queued. Brain is down. Will retry.") and retried after **1 minute** rather than the hourly outage cadence. A write that lands late is adopted by the retry, never written twice.
- The post fence's live lease read reuses the fire path's own check when it is under 2 s old, and is capped at 0.7 s.
- **What stays measured, not bounded:** time an event waits in the serial lane behind another single entry's work. Periodic jobs take the lane one entry at a time, never for a whole job. Ack latency is timed from socket receipt, with P50/P95/max and `ackBreachCount` on `/health`. The Phase 5 proof pack records it (acceptance: under 3 s, measured).

## 11d. Post fencing (OPT-FU-1 / KAR-FU-1)
- Every post does a **live** read of the lease row (epoch + holder), like a fire, so a deposed holder cannot post inside its last heartbeat interval.
- If the brain cannot be reached, the heartbeat-confirmed local check stands, and the lease rule stops all posting after 3 missed heartbeats.
- The fence was tightened, not loosened. Flag #16 (the brain-down reply only in the first 90 s of an outage) is unchanged, as COUNCIL GATE ruled.
- The JB start relay (`fire` post-queue entries) goes through the same fence and alerts on any refusal (C1-FU-7).

## 12. Kill switch

**Measured, not counted by hand (ECO-FU-3).** Every Monday at the 9am check-in, the Muse program writes the week's line to `/var/lib/cto-relay/muse/weekly-review.jsonl` and alerts Muse CTO with the numbers. The line holds:
- starts total and per CTO (brain rows);
- fired-run tokens reported at close-out, plus how many runs were unmetered;
- the weekly share of the 600,000-token ceiling;
- whether the week was below the floor of 5.

When the total stays below 5 for two reviews in a row and did not rise, it raises **`kill-switch-condition-met`**. Muse CTO then decides.

Review tokens (≤ 50,000 a week) are Muse CTO's own harness spend. They are recorded as `null` in the line and filled in at the review. Every start also leaves a cost line, including starts that never closed: those are 0 tokens if the start never ran, unmetered if it ran (ECO-FU-2).

**Pause.** If starts per week stay below 5 for two reviews in a row and the trend is flat:
1. Run:
   ```bash
   sudo systemctl stop cto-relay-muse cto-relay-claude cto-relay-gemini cto-relay-axon-hermes
   ```
2. Post "relay paused" in #cto-bots through the post-queue, before stopping Muse.
3. Write a runbook entry.

**Resume:** reverse the steps, with a runbook entry.

---

## 13. Phase 2 exit tests — procedures

### Recorded facts (C1-FU-1 / C2-FU-8 / R3-FU-11)
Measured live 2026-11-05 19:22 EST.

**VM headroom:**
- RAM: 7.9 GB total, 952 MB available.
- CPUs: 4. Load average 3.35 (the VM was busy at measure time).
- Disk: 79 GB free on `/home`, 7.0 GB free on `/`.
- **Fit:** the four relay services cap at `MemoryMax=128M` each, 512 MB total, which fits the available RAM.

**Paid host:** the relay is hosted on this VM. There is **no paid host and no paid-host price** to pay. No provider price is recorded, because none applies.

**Paid-host trigger (D4 limits table)** — re-measure at the 30/60-day review:
- 15-minute load average over 70% of the core count for 1 hour (here, 2.8 on 4 cores); or
- disk under 10 GB.

At measure time, `/` was **already under 10 GB (7.0 GB free)**. The relay's state lives under `/var/lib`, so watch `/` and record it at each review.

| Test | How | Automated coverage |
|---|---|---|
| Health endpoints answer with numbers incl. adapter health | `curl` each port on localhost + 198.19.0.2 | — |
| One-token revocation | §5 | sibling watch + exit 78 path |
| Kill one program | `sudo systemctl kill -s KILL cto-relay-gemini`. The other three keep answering; systemd restarts Gemini; restore re-posts state | — |
| Breaker-count restart | trip the breaker (4 attempts / 10 min), `systemctl restart`, a 5th attempt is still refused | `test/core.test.ts` "breaker restart test" |
| Journal failure → no run | `CTO_RELAY_ENABLE_TEST_HOOKS=1` on a test unit, then `cto-relay admin test-fail-next-journal-write --cto muse`, then fire. The row is voided (`refused`), "Not started." is posted, no run starts | `test/core.test.ts` "journal-failure test" |
| VM headroom | **Recorded — measured live 2026-11-05 19:22 EST** (see below) | — |
| Paid-host price | **Recorded — none.** The relay runs on this VM; there is no paid host and no paid-host price to pay. | — |
| Solo rebuild | Claude CTO rebuilds from this runbook alone within 2 h; smoke test passes | — |

Local checks, run in the repo:
```bash
npm ci && npm run check
```
That runs typecheck (`tsc --noEmit`), the test suite (74 tests), and the key-pattern grep. Run `npm run lint:shell` for the deploy scripts.
