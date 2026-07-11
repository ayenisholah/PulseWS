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
- HMAC-authenticated private channel subscriptions plus a dependency-free
  Node.js example authorization endpoint.
- Private-channel client events with sender exclusion and configurable
  per-connection token-bucket rate limiting.
- Single-node presence channels with authenticated membership, unique-user
  rosters, join/leave events, and disconnect cleanup.
- Opt-in integrated browser demo with live node and connection state, presence
  roster, bounded event log, and peer client-event controls.
- Redis event adapter with dedicated publisher/subscriber connections,
  per-app fan-out channels, echo-path local delivery, socket exclusion, and
  conditional two-node integration coverage backed by Redis 7 in CI.
- Redis-backed presence membership with atomic Lua join/leave operations,
  cluster-wide unique-user rosters, cross-node member lifecycle events, and
  async-safe subscribe, unsubscribe, and disconnect handling.
- Redis node heartbeats, persistent socket bookkeeping, atomic dead-node
  presence cleanup, cluster-wide connection reservations, and final member
  removal fan-out after crashes.
- Configurable REST publish token buckets with HTTP 429 responses and
  `PULSEWS_CLUSTER_SIZE` per-node allowance division.
- Production TypeScript emit build, non-root multi-stage Docker image, health
  endpoint, and a two-node Compose topology with Redis 7, nginx,
  Prometheus, and Grafana.
- Cluster smoke harness covering distinct load-balanced nodes, demo
  authorization, Redis presence, and signed cross-node REST delivery.
- VPS Compose acceptance evidence for distinct `pulsews-a`/`pulsews-b`
  routing, shared presence, nginx authorization, and HTTP 200 signed REST
  publishing.
- Production failover acceptance covering SIGTERM shutdown of `pulsews-a`,
  automatic `pusher-js` reconnection through nginx, post-reconnect presence,
  signed delivery to both clients, and successful node restart.

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
