#!/usr/bin/env bash
# cto-relay-mini-sync.sh — the CHECKED failover step (PLAN-v7 D6). Owner: Muse CTO
# (Claude CTO when Muse CTO is offline). Run on the mini.
#
#   cto-relay-mini-sync.sh            verify only: prints PROCEED or ABORT
#   cto-relay-mini-sync.sh --start    verify, then start the four mini relays
#   cto-relay-mini-sync.sh --nightly  nightly pull (fast-forward to origin/main) + verify, no start
#
# Verification: the mini's repo commit + config hash must equal the expected
# commit + config hash in the vault file cto-relay-expected.json (updated by
# every deploy). If the mini is behind (or different), ABORT the failover and alert.
set -euo pipefail
REPO="${CTO_RELAY_MINI_REPO:-/opt/cto-relay}"
VAULT_DIR="${CTO_RELAY_MINI_VAULT_DIR:-<MINI_VAULT_CHECKOUT_DIR>}"
EXPECTED_REL="${CTO_RELAY_EXPECTED_PATH:-<VAULT_PATH_TO>/cto-relay-expected.json}"
ALERTS=/var/lib/cto-relay/mini/alerts.jsonl
mode="${1:-verify}"

alert() {
  mkdir -p "$(dirname "$ALERTS")"
  printf '{"at":"%s","code":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$ALERTS"
  echo "ABORT: $1 ($2)" >&2
}

case "$VAULT_DIR$EXPECTED_REL" in *"<"*) alert mini-sync-not-configured "set CTO_RELAY_MINI_VAULT_DIR and CTO_RELAY_EXPECTED_PATH"; exit 2 ;; esac

git -C "$VAULT_DIR" fetch --quiet origin main || { alert vault-fetch-failed "$VAULT_DIR"; exit 2; }
expected_json=$(git -C "$VAULT_DIR" show "origin/main:$EXPECTED_REL") || { alert expected-file-missing "$EXPECTED_REL"; exit 2; }
exp_commit=$(printf '%s' "$expected_json" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p')
exp_hash=$(printf '%s' "$expected_json" | sed -n 's/.*"configHash"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$exp_commit" ] && [ -n "$exp_hash" ] || { alert expected-file-bad "$EXPECTED_REL"; exit 2; }

if [ "$mode" = "--nightly" ]; then
  git -C "$REPO" fetch --quiet origin main && git -C "$REPO" merge --ff-only --quiet origin/main || alert nightly-pull-failed "$REPO"
fi

mini_commit=$(git -C "$REPO" rev-parse HEAD)
mini_hash=$("$REPO/deploy/scripts/config-hash.sh" "$REPO")
if [ "$mini_commit" != "$exp_commit" ] || [ "$mini_hash" != "$exp_hash" ]; then
  alert mini-behind-expected "mini $mini_commit/$mini_hash expected $exp_commit/$exp_hash"
  exit 1
fi

# The off-host journal copies must be present for each CTO (takeover reads them).
for c in muse claude gemini axon-hermes; do
  d="/var/lib/cto-relay/$c"
  if [ -f "$d/journal.jsonl.sha256" ]; then
    ( cd "$d" && { sha256sum -c journal.jsonl.sha256 >/dev/null 2>&1 || shasum -a 256 -c journal.jsonl.sha256 >/dev/null; } ) || { alert offhost-copy-checksum-bad "$c"; exit 1; }
  else
    alert offhost-copy-missing "$c"; exit 1
  fi
done

echo "PROCEED: mini at expected commit $mini_commit, config hash $mini_hash"
if [ "$mode" = "--start" ]; then
  for c in muse claude gemini axon-hermes; do
    sudo launchctl bootstrap system "/Library/LaunchDaemons/com.northside.cto-relay.$c.plist" 2>/dev/null || sudo launchctl kickstart -k "system/com.northside.cto-relay.$c"
  done
  echo "Mini relays started. Each acquires its lease with epoch+1 once the VM lease has expired (90 s)."
fi
