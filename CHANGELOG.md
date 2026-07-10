# Changelog

All notable changes to PulseWS are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).
Changes accumulate under **[Unreleased]** and roll into a version at each
release.

## [Unreleased]

### Added

- TypeScript project scaffold with npm verify wiring, strict `tsconfig.json`,
  allowed runtime/test dependencies, and a first Vitest unit test.
- Zod-validated JSON config loader with example config and tests for valid
  load plus readable invalid-config failures.
- uWebSockets.js server skeleton with Pusher-compatible connection handshake
  and unknown-app-key refusal tests.
- Public channel classification, subscribe/unsubscribe handling on uWS topics,
  internal local publish fan-out, and pusher-js delivery tests.
- Pusher ping/pong responses, inbound activity tracking, and server-side
  reaping of connections silent beyond the activity timeout plus grace.
- Pusher-compatible REST publish authentication with raw-body MD5, canonical
  query signing, constant-time HMAC verification, and replay protection.
- REST publish endpoint with request validation, ingress body-size limits,
  and local event fan-out through a delivery adapter seam.

### Changed

- Raised the minimum supported runtime and CI environment from Node 20 to Node
  22 to match the pinned uWebSockets.js release.
- Replaced the placeholder package-name unit test with scaffold integrity
  checks for scripts, ESM mode, and the approved dependency allowlist.
- Simplified CI and local verification to install dependencies and run build,
  lint, and tests.

## [0.0.1] - 2026-07-10

### Added

- Initial project documentation: README, engineering spec
  (`docs/pulsews-engineering-doc.md`), decision log, and this changelog.
- Repository setup scripts for local git identity and a CI workflow for
  build, lint, and test checks.
- Repo hygiene: MIT license, `.gitignore`, `.gitattributes`, `.editorconfig`.
