#!/usr/bin/env bash
# One-command bootstrap. Run once per clone.
# Initializes the repo if needed, sets the repo-local identity, and activates
# the governance hooks in .githooks/.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -b main
  echo "setup: initialized git repository (branch: main)"
fi

git config user.name "Shola Ayeni"
git config user.email "ayenisholah@yahoo.com"
git config core.hooksPath .githooks

echo "setup: repo-local git identity -> $(git config user.name) <$(git config user.email)>"
echo "setup: hooks path              -> $(git config core.hooksPath)"
echo "setup: done. Run scripts/verify.sh before every commit."
