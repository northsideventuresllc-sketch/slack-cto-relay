#!/usr/bin/env bash
# mini-run.sh <cto> — start one relay on the mini (launchd). Keys are read from the
# per-CTO macOS user's login keychain into a private temp dir (0700, removed on exit).
# Keychain item names are placeholders: set them when the keychains are created.
set -euo pipefail
cto="$1"
key_dir=$(mktemp -d); chmod 0700 "$key_dir"; trap 'rm -rf "$key_dir"' EXIT
umask 0277
security find-generic-password -s "<KEYCHAIN_ITEM_SLACK_APP_TOKEN>" -w > "$key_dir/slack-app-token"
security find-generic-password -s "<KEYCHAIN_ITEM_SLACK_BOT_TOKEN>" -w > "$key_dir/slack-bot-token"
if [ "$cto" = muse ]; then security find-generic-password -s "cto-relay-muse" -w > "$key_dir/brain-key"; fi
export CTO_RELAY_CTO="$cto" CTO_RELAY_KEY_DIR="$key_dir" CTO_RELAY_HOLDER=mini \
  CTO_RELAY_STATE_DIR="/var/lib/cto-relay/$cto" CTO_RELAY_RUN_DIR=/var/run/cto-relay \
  CTO_RELAY_HEALTH_BIND="${CTO_RELAY_MINI_HEALTH_BIND:-127.0.0.1}"
# shellcheck source=/dev/null
[ -f /etc/cto-relay/relay.env ] && set -a && . /etc/cto-relay/relay.env && set +a
node /opt/cto-relay/dist/index.js run
