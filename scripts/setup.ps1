# One-command bootstrap. Run once per clone.
# Initializes the repo if needed and sets the repo-local identity.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path ".git")) {
  git init -b main
  Write-Host "setup: initialized git repository (branch: main)"
}

git config user.name "Shola Ayeni"
git config user.email "ayenisholah@yahoo.com"

Write-Host ("setup: repo-local git identity -> {0} <{1}>" -f (git config user.name), (git config user.email))
Write-Host "setup: done. Run scripts/verify.ps1 before every commit."
