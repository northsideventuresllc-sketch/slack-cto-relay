#!/usr/bin/env bash
# deploy.sh — install or update the relay on the VM. Run as root from a checkout
# of the commit being deployed:   sudo deploy/scripts/deploy.sh [--vault-token-stdin]
#
# - creates the four service users/groups + cto-relay-admin (idempotent)
# - installs the code at /opt/cto-relay (npm ci + build), units, tmpfiles, hooks
# - --vault-token-stdin: writes the vault-cli-machine token from STDIN to
#   /etc/cto-relay/vault-token (0400 root). Never pass it on argv.
# - prints the commit + config hash for cto-relay-expected.json (the vault file
#   the mini sync checks); every deploy must update that file.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
src="$(cd "$(dirname "$0")/../.." && pwd)"
CTOS="muse claude gemini axon-hermes"

getent group cto-relay-admin >/dev/null || groupadd --system cto-relay-admin
for c in $CTOS; do
  u="cto-relay-$c"
  getent group "$u" >/dev/null || groupadd --system "$u"
  id "$u" >/dev/null 2>&1 || useradd --system --gid "$u" --home-dir "/var/lib/cto-relay/$c" --no-create-home --shell /usr/sbin/nologin "$u"
done
# Muse must be able to hand each broker socket to that CTO's group.
usermod -a -G cto-relay-admin,cto-relay-claude,cto-relay-gemini,cto-relay-axon-hermes cto-relay-muse
for c in claude gemini axon-hermes; do usermod -a -G cto-relay-admin "cto-relay-$c"; done

install -d -m 0755 /etc/cto-relay
if [ "${1:-}" = "--vault-token-stdin" ]; then
  umask 0277
  cat > /etc/cto-relay/vault-token
  chown root:root /etc/cto-relay/vault-token
  chmod 0400 /etc/cto-relay/vault-token
  umask 0022
  echo "vault-token written (0400 root)"
fi
[ -f /etc/cto-relay/relay.env ] || install -m 0644 "$src/deploy/etc/relay.env.example" /etc/cto-relay/relay.env
[ -f /etc/cto-relay/fetch-keys.conf ] || install -m 0600 "$src/deploy/etc/fetch-keys.conf.example" /etc/cto-relay/fetch-keys.conf
[ -f /etc/cto-relay/offhost.env ] || install -m 0600 "$src/deploy/etc/offhost.env.example" /etc/cto-relay/offhost.env
# C2-FU-11: every config file the services read, any-case placeholders (<UPPER>, <lower>, <Mixed_Case>).
placeholder_files="/etc/cto-relay/relay.env /etc/cto-relay/fetch-keys.conf /etc/cto-relay/offhost.env $src/config/registry.json $src/deploy/sudoers/cto-relay"
if grep -n -E '<[A-Za-z][A-Za-z0-9_-]*>' $placeholder_files; then
  echo "WARNING: the lines above still hold <PLACEHOLDER> values — fill them before starting (runbook §2). The services refuse to start while they remain." >&2
fi

# Code
rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$src/" /opt/cto-relay/
( cd /opt/cto-relay && npm ci --omit=dev --ignore-scripts && npm install --no-save typescript@7.0.2 @types/node@22 && npx tsc -p tsconfig.build.json && npm prune --omit=dev )
chown -R root:root /opt/cto-relay
install -m 0755 "$src/deploy/scripts/cto-relay-fetch-keys" /usr/local/bin/cto-relay-fetch-keys
install -m 0755 "$src/deploy/scripts/cto-relay-offhost-copy.sh" /usr/local/bin/cto-relay-offhost-copy.sh
# GitHub's SSH host keys for the vault deploy keys: pin them, then CHECK the fingerprints
# against GitHub's published list (docs.github.com, "GitHub's SSH key fingerprints") before use.
[ -f /etc/cto-relay/known_hosts ] || { ssh-keyscan -t ed25519,ecdsa,rsa github.com > /etc/cto-relay/known_hosts 2>/dev/null && chmod 0644 /etc/cto-relay/known_hosts && ssh-keygen -lf /etc/cto-relay/known_hosts; }
printf '#!/bin/sh\nexec /usr/bin/node /opt/cto-relay/dist/index.js "$@"\n' > /usr/local/bin/cto-relay && chmod 0755 /usr/local/bin/cto-relay

# Units + runtime dirs
install -m 0644 "$src/deploy/tmpfiles/cto-relay.conf" /etc/tmpfiles.d/cto-relay.conf
systemd-tmpfiles --create /etc/tmpfiles.d/cto-relay.conf
for f in "$src"/deploy/systemd/*.service "$src"/deploy/systemd/*.timer; do install -m 0644 "$f" /etc/systemd/system/; done
install -m 0440 "$src/deploy/sudoers/cto-relay" /etc/sudoers.d/cto-relay && visudo -cf /etc/sudoers.d/cto-relay
systemctl daemon-reload

commit=$(git -C "$src" rev-parse HEAD)
chash=$("$src/deploy/scripts/config-hash.sh" "$src")
echo
echo "Installed commit $commit, config hash $chash."
echo "Update the vault file cto-relay-expected.json to:"
printf '{ "commit": "%s", "configHash": "%s", "deployedAt": "%s" }\n' "$commit" "$chash" "$(date -u +%FT%TZ)"
echo "Then: systemctl enable --now cto-heartbeat.timer cto-relay-offhost-copy.timer cto-relay-muse cto-relay-claude cto-relay-gemini cto-relay-axon-hermes"
