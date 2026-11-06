#!/usr/bin/env bash
# mini-poller.sh — the 1-minute cron on the mini (PLAN-v7 D6). crontab of user cto-relay-muse:
#   * * * * * /opt/cto-relay/deploy/scripts/mini-poller.sh >> /var/log/cto-relay-poller.log 2>&1
# The cto-relay-muse brain key (and the Muse bot token, for the dead-owner fallback sweep)
# come from that user's login keychain and reach the poller on stdin only.
set -euo pipefail
brain=$(security find-generic-password -s "cto-relay-muse" -w)
bot=$(security find-generic-password -s "cto-relay-muse-slack-bot" -w 2>/dev/null || true)
# shellcheck source=/dev/null
[ -f /etc/cto-relay/relay.env ] && set -a && . /etc/cto-relay/relay.env && set +a
export CTO_RELAY_VM_LAN="${CTO_RELAY_VM_LAN:-198.19.0.2}"
# printf is a shell builtin: the values never appear on any process's argv.
if [ -n "$bot" ]; then
  printf '{"brainKey":"%s","slackBotToken":"%s"}' "$brain" "$bot" | node /opt/cto-relay/dist/index.js poller
else
  printf '{"brainKey":"%s"}' "$brain" | node /opt/cto-relay/dist/index.js poller
fi
