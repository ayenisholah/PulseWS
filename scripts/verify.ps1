# The single entrypoint to run before every commit: build, lint, and tests.
# PowerShell mirror of verify.sh.
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")
$fail = 0

Write-Host "== governance =="
if (-not $env:CI) {
  $hooks = git config core.hooksPath
  if ($hooks -ne ".githooks") {
    Write-Host "FAIL: core.hooksPath is '$hooks', expected '.githooks' - run scripts/setup.ps1"
    $fail = 1
  }
  $name = git config user.name
  $email = git config user.email
  if ("$name <$email>" -ne "Shola Ayeni <ayenisholah@yahoo.com>") {
    Write-Host "FAIL: git identity is '$name <$email>' - run scripts/setup.ps1"
    $fail = 1
  }
}

$bashCmd = Get-Command bash -ErrorAction SilentlyContinue
if ($bashCmd) {
  $bashPath = $bashCmd.Source
} else {
  $candidate = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
  if (Test-Path $candidate) { $bashPath = $candidate } else { $bashPath = $null }
}
if ($bashPath) {
  & $bashPath scripts/check-commits.sh
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
  Write-Host "WARN: bash not found - skipped commit-history audit (CI still runs it)"
}

if (Test-Path "package.json") {
  Write-Host "== code =="
  npm run verify
  if ($LASTEXITCODE -ne 0) { $fail = 1 }
} else {
  Write-Host "== code == (skipped - no package.json yet; wired up in task W1D1-1)"
}

if ($fail -eq 0) {
  Write-Host "verify: PASS"
} else {
  Write-Host "verify: FAIL"
}
exit $fail
