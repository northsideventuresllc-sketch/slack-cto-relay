#!/usr/bin/env bash
# mini-checkin.sh — Claude CTO's 9am check-in report (R7-NEW-5 dead-alerter fallback).
# Run on the mini as cto-relay-muse (directly, or over SSH: ssh <MINI_SSH_DEST> /opt/cto-relay/deploy/scripts/mini-checkin.sh).
# Shows Muse CTO's and the poller's heartbeat ages and every unread alert in
# /var/lib/cto-relay/mini/alerts.jsonl. The brain key reaches node on stdin only.
set -euo pipefail
brain=$(security find-generic-password -s "cto-relay-muse" -w)
# shellcheck source=/dev/null
[ -f /etc/cto-relay/relay.env ] && set -a && . /etc/cto-relay/relay.env && set +a
printf '{"brainKey":"%s"}' "$brain" | node /opt/cto-relay/dist/index.js checkin-report
