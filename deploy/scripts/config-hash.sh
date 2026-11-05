#!/usr/bin/env bash
# Prints the config hash recorded in cto-relay-expected.json: SHA-256 over
# config/registry.json followed by config/blocklist.json (byte for byte).
set -euo pipefail
repo="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cat "$repo/config/registry.json" "$repo/config/blocklist.json" | { sha256sum 2>/dev/null || shasum -a 256; } | awk '{print $1}'
