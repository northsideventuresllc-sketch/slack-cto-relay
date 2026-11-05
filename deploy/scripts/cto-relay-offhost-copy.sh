#!/usr/bin/env bash
# cto-relay-offhost-copy.sh — nightly (cto-relay-offhost-copy.timer), on the VM, as root.
# 1. Copies each program's journal and run log to the mini (off-host copy, D6).
# 2. Writes per-file .sha256 next to each copy and the day's checksum file
#    backups/<date>.sha256 in the vault repo (checksum store, D6).
# 3. Hygiene check: verifies the copies on the mini (checksum + record count)
#    and alerts Muse CTO on failure (alert file read by the 9am check-in).
set -euo pipefail
: "${MINI_SSH_DEST:?}" "${MINI_SSH_KEY:?}" "${MINI_STATE_ROOT:?}" "${VAULT_DIR:?}"
case "$MINI_SSH_DEST$VAULT_DIR" in *"<"*) echo "offhost.env has placeholders" >&2; exit 78 ;; esac
day=$(date -u +%F)
ssh_opts=(-i "$MINI_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
sumfile="$work/$day.sha256"
fail=0
for c in muse claude gemini axon-hermes; do
  src="/var/lib/cto-relay/$c"
  [ -d "$src" ] || continue
  for f in journal.jsonl run-log.jsonl; do
    [ -f "$src/$f" ] || continue
    cp "$src/$f" "$work/$c-$f"
    ( cd "$work" && sha256sum "$c-$f" ) >> "$sumfile"
    count=$(wc -l < "$work/$c-$f" | tr -d ' ')
    rsync -a -e "ssh ${ssh_opts[*]}" "$work/$c-$f" "$MINI_SSH_DEST:$MINI_STATE_ROOT/$c/$f"
    ( cd "$work" && sha256sum "$c-$f" | sed "s/$c-$f/$f/" ) > "$work/$c-$f.sha256"
    rsync -a -e "ssh ${ssh_opts[*]}" "$work/$c-$f.sha256" "$MINI_SSH_DEST:$MINI_STATE_ROOT/$c/$f.sha256"
    remote_count=$(ssh "${ssh_opts[@]}" "$MINI_SSH_DEST" "wc -l < '$MINI_STATE_ROOT/$c/$f'" | tr -d ' ')
    remote_ok=$(ssh "${ssh_opts[@]}" "$MINI_SSH_DEST" "cd '$MINI_STATE_ROOT/$c' && (sha256sum -c '$f.sha256' >/dev/null 2>&1 || shasum -a 256 -c '$f.sha256' >/dev/null 2>&1) && echo ok || echo bad")
    if [ "$remote_ok" != ok ] || [ "$remote_count" != "$count" ]; then fail=1; echo "hygiene: $c/$f mismatch" >&2; fi
  done
done
install -d "$VAULT_DIR/backups"
cp "$sumfile" "$VAULT_DIR/backups/$day.sha256"
git -C "$VAULT_DIR" add "backups/$day.sha256"
git -C "$VAULT_DIR" commit -q -m "cto-relay off-host copy checksums $day" || true
git -C "$VAULT_DIR" push -q origin HEAD:main || fail=1
if [ "$fail" = 1 ]; then
  printf '{"at":"%s","cto":"muse","code":"offhost-copy-hygiene-failed"}\n' "$(date -u +%FT%TZ)" >> /var/lib/cto-relay/muse/alerts.jsonl
  exit 1
fi
echo "off-host copy + hygiene OK for $day"
