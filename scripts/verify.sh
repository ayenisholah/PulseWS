#!/usr/bin/env bash
# The single entrypoint to run before every commit: build, lint, and tests.
#   - governance checks (hooks active, identity correct, commit history clean)
#   - code checks (typecheck + tests) once package.json exists (task W1D1-1)
set -u
cd "$(dirname "$0")/.."
fail=0

echo "== governance =="
if [ -z "${CI:-}" ]; then
  hooks=$(git config core.hooksPath || true)
  if [ "$hooks" != ".githooks" ]; then
    echo "FAIL: core.hooksPath is '$hooks', expected '.githooks' — run scripts/setup.sh"
    fail=1
  fi
  ident="$(git config user.name || true) <$(git config user.email || true)>"
  if [ "$ident" != "Shola Ayeni <ayenisholah@yahoo.com>" ]; then
    echo "FAIL: git identity is '$ident' — run scripts/setup.sh"
    fail=1
  fi
fi

bash scripts/check-commits.sh || fail=1

if [ -f package.json ]; then
  echo "== code =="
  npm run verify || fail=1
else
  echo "== code == (skipped — no package.json yet; wired up in task W1D1-1)"
fi

if [ "$fail" -eq 0 ]; then
  echo "verify: PASS"
else
  echo "verify: FAIL"
fi
exit "$fail"
