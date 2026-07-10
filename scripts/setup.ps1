# One-command bootstrap. Run once per clone.
# Initializes the repo if needed, sets the repo-local identity, and activates
# the governance hooks in .githooks/.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path ".git")) {
  git init -b main
  Write-Host "setup: initialized git repository (branch: main)"
}

git config user.name "Shola Ayeni"
git config user.email "ayenisholah@yahoo.com"
git config core.hooksPath .githooks

Write-Host ("setup: repo-local git identity -> {0} <{1}>" -f (git config user.name), (git config user.email))
Write-Host ("setup: hooks path              -> {0}" -f (git config core.hooksPath))
Write-Host "setup: done. Run scripts/verify.ps1 before every commit."
