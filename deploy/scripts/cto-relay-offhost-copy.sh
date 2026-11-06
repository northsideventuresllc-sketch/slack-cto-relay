#!/usr/bin/env bash
# cto-relay-offhost-copy.sh — nightly (cto-relay-offhost-copy.timer), on the VM, as root.
# 1. Copies each program's journal and run log to the mini (off-host copy, D6).
# 2. Writes per-file .sha256 next to each copy and the day's checksum file
#    backups/<date>.sha256 in the vault repo (checksum store, D6).
# 3. Hygiene check: verifies the copies on the mini (checksum + record count)
#    and alerts Muse CTO on failure (alert file read by the 9am check-in).
# 4. Copy vs brain (R5-FU-9): `cto-relay copy-check` hands each journal copy's
#    fire ids to the Muse program, which compares them with the brain rows and
#    posts any gap in #cto-bots.
# 5. Files the Muse mirror (R7-FU-11) and the 90-day brain-row archive
#    (R7-FU-12) into the vault within a day: $VAULT_MIRROR_PATH, $VAULT_ARCHIVE_PATH.
# C2-FU-10: no `set -e` — every step is checked, so one failure is alerted and the
# other CTOs are still copied; an unexpected error trips the ERR trap, which alerts.
set -uo pipefail
: "${MINI_SSH_DEST:?}" "${MINI_SSH_KEY:?}" "${MINI_STATE_ROOT:?}" "${VAULT_DIR:?}" "${VAULT_MIRROR_PATH:?}" "${VAULT_ARCHIVE_PATH:?}"
case "$MINI_SSH_DEST$VAULT_DIR$VAULT_MIRROR_PATH$VAULT_ARCHIVE_PATH" in *"<"*) echo "offhost.env has placeholders" >&2; exit 78 ;; esac
ALERTS=/var/lib/cto-relay/muse/alerts.jsonl
alert() { # capped like the program's own alert log (R7-NEW-5): rotate past 1 MiB, keep 3
  if [ -f "$ALERTS" ] && [ "$(stat -c %s "$ALERTS")" -gt 1048576 ]; then
    rm -f "$ALERTS.3"; [ -f "$ALERTS.2" ] && mv "$ALERTS.2" "$ALERTS.3"; [ -f "$ALERTS.1" ] && mv "$ALERTS.1" "$ALERTS.2"; mv "$ALERTS" "$ALERTS.1"
  fi
  printf '{"at":"%s","cto":"muse","code":"%s"}\n' "$(date -u +%FT%TZ)" "$1" >> "$ALERTS"
}
trap 'alert "offhost-copy-error-line-$LINENO"' ERR
day=$(date -u +%F)
ssh_opts=(-i "$MINI_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
sumfile="$work/$day.sha256"
fail=0
step_fail() { fail=1; alert "$1"; echo "offhost: $1" >&2; }
for c in muse claude gemini axon-hermes; do
  src="/var/lib/cto-relay/$c"
  # C2-FU-10: all four programs are deployed, so a missing state dir is a fault, not a skip.
  if [ ! -d "$src" ]; then step_fail "offhost-state-dir-missing-$c"; continue; fi
  for f in journal.jsonl run-log.jsonl; do
    [ -f "$src/$f" ] || continue   # a program that has written nothing yet has no file
    cp "$src/$f" "$work/$c-$f" || { step_fail "offhost-local-copy-failed-$c"; continue; }
    ( cd "$work" && sha256sum "$c-$f" ) >> "$sumfile"
    count=$(wc -l < "$work/$c-$f" | tr -d ' ')
    rsync -a -e "ssh ${ssh_opts[*]}" "$work/$c-$f" "$MINI_SSH_DEST:$MINI_STATE_ROOT/$c/$f" || { step_fail "offhost-rsync-failed-$c"; continue; }
    ( cd "$work" && sha256sum "$c-$f" | sed "s/$c-$f/$f/" ) > "$work/$c-$f.sha256"
    rsync -a -e "ssh ${ssh_opts[*]}" "$work/$c-$f.sha256" "$MINI_SSH_DEST:$MINI_STATE_ROOT/$c/$f.sha256" || { step_fail "offhost-rsync-failed-$c"; continue; }
    remote_count=$(ssh "${ssh_opts[@]}" "$MINI_SSH_DEST" "wc -l < '$MINI_STATE_ROOT/$c/$f'" | tr -d ' ') || remote_count=""
    remote_ok=$(ssh "${ssh_opts[@]}" "$MINI_SSH_DEST" "cd '$MINI_STATE_ROOT/$c' && (sha256sum -c '$f.sha256' >/dev/null 2>&1 || shasum -a 256 -c '$f.sha256' >/dev/null 2>&1) && echo ok || echo bad") || remote_ok=bad
    if [ "$remote_ok" != ok ] || [ "$remote_count" != "$count" ]; then step_fail "offhost-hygiene-mismatch-$c"; fi
  done
  if [ -f "$work/$c-journal.jsonl" ]; then
    /usr/local/bin/cto-relay copy-check --target "$c" --copy "$work/$c-journal.jsonl" >/dev/null || step_fail "offhost-copy-check-failed-$c"
  fi
done

# Vault filing with the WRITE deploy key (C2-FU-2), fetched into tmpfs by ExecStartPre.
WRITE_KEY=/run/credentials/cto-relay-offhost/vault-write-key
if [ -r "$WRITE_KEY" ]; then
  export GIT_SSH_COMMAND="ssh -i $WRITE_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/cto-relay/known_hosts"
else
  step_fail offhost-vault-write-key-missing
fi
if [ ! -d "$VAULT_DIR/.git" ] && [ -n "${VAULT_REPO_URL:-}" ]; then
  git clone -q "$VAULT_REPO_URL" "$VAULT_DIR" || step_fail offhost-vault-clone-failed
fi
if git -C "$VAULT_DIR" pull -q --ff-only origin main; then
  install -d "$VAULT_DIR/backups" "$VAULT_DIR/$VAULT_MIRROR_PATH" "$VAULT_DIR/$VAULT_ARCHIVE_PATH"
  cp "$sumfile" "$VAULT_DIR/backups/$day.sha256" 2>/dev/null || true
  if [ -d /var/lib/cto-relay/muse/mirror ]; then rsync -a /var/lib/cto-relay/muse/mirror/ "$VAULT_DIR/$VAULT_MIRROR_PATH/" || step_fail offhost-mirror-copy-failed; fi
  if [ -d /var/lib/cto-relay/muse/archive ]; then rsync -a /var/lib/cto-relay/muse/archive/ "$VAULT_DIR/$VAULT_ARCHIVE_PATH/" || step_fail offhost-archive-copy-failed; fi
  git -C "$VAULT_DIR" add -A "backups" "$VAULT_MIRROR_PATH" "$VAULT_ARCHIVE_PATH" || step_fail offhost-vault-add-failed
  git -C "$VAULT_DIR" commit -q -m "cto-relay nightly: copy checksums, mirror, brain archive $day" || true   # nothing new is fine
  git -C "$VAULT_DIR" push -q origin HEAD:main || step_fail offhost-vault-push-failed
else
  step_fail offhost-vault-pull-failed
fi
if [ "$fail" = 1 ]; then
  alert offhost-copy-hygiene-failed
  exit 1
fi
echo "off-host copy + hygiene + vault filing OK for $day"
