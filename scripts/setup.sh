#!/usr/bin/env bash
# One-command bootstrap. Run once per clone.
# Initializes the repo if needed and sets the repo-local identity.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  git init -b main
  echo "setup: initialized git repository (branch: main)"
fi

git config user.name "Shola Ayeni"
git config user.email "ayenisholah@yahoo.com"

echo "setup: repo-local git identity -> $(git config user.name) <$(git config user.email)>"
echo "setup: done. Run scripts/verify.sh before every commit."
