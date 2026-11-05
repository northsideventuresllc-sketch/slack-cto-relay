#!/usr/bin/env bash
# Key-pattern grep (Phase 1 exit criterion): fails if any tracked or staged file
# carries something shaped like a real token or key. Placeholders such as
# <SUPABASE_URL> are fine.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pattern='xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
files=$(git ls-files --cached --others --exclude-standard | grep -v -E '^(node_modules|dist)/' || true)
if [ -z "$files" ]; then echo "no files"; exit 0; fi
# shellcheck disable=SC2086
if echo "$files" | xargs grep -n -E "$pattern" -- 2>/dev/null; then
  echo "FAIL: key-shaped string found (see above). Remove it; keys live in the Secure Vault only." >&2
  exit 1
fi
echo "key-pattern grep: clean ($(echo "$files" | wc -l | tr -d ' ') files)"
