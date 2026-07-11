# PulseWS

Self-hosted, Pusher-compatible WebSocket pub/sub server in TypeScript.

PulseWS is being built as a drop-in real-time messaging server for applications
that already use `pusher-js` and the official Pusher server SDKs. The goal is
protocol compatibility first, then Redis-backed horizontal fan-out,
observability, and measured load-test results.

## Status

Pre-alpha. The TypeScript scaffold, validated config loading,
uWebSockets.js handshake, public channels, connection liveness, and the signed
REST publishing and the single-node MVP are in place, including public,
private, and presence channels, rate-limited client events, and an opt-in live
browser demo. The next milestone is Redis-backed multi-node fan-out.

Implemented:

| Area | Status |
|---|---|
| TypeScript project scaffold | Done |
| Strict typecheck and Vitest verify loop | Done |
| Validated JSON config loader | Done |
| Pusher protocol handshake | Done |
| Public channel subscribe/unsubscribe | Done |
| Ping/pong liveness and connection reaping | Done |
| Signed REST publish API | Done |
| Private channels | Done |
| Client events and per-connection rate limiting | Done |
| Presence channels | Done (single node) |
| Integrated browser demo | Done |
| Redis fan-out adapter | Planned |
| Prometheus metrics and Grafana dashboard | Planned |
| k6 load-test writeup with measured results | Planned |

No performance numbers are claimed until they are measured and committed with
the load-test report.

## Why

Hosted real-time services price by concurrent connections and message volume.
For teams that already depend on the Pusher protocol, the lowest-friction
self-hosting path is protocol compatibility: keep the existing client and
server SDKs, change the host configuration, and move the fan-out infrastructure
in-house.

PulseWS targets that migration path:

- `pusher-js` protocol 7 compatibility.
- Public, private, and presence channels.
- Signed publish API compatible with the official Pusher Node SDK.
- Redis pub/sub for multi-node delivery.
- Per-app credentials, limits, rate limiting, and Prometheus metrics.
- k6 scenarios that publish measured connection and latency results.

## Development

Requirements:

- Node.js 22+
- npm
- Bash or Git Bash if you want to run `scripts/verify.sh`

Install dependencies:

```sh
npm install
```

Run the project verification loop:

```sh
npm run verify
```

On Windows, the repository-level verification script may need an execution
policy bypass:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

## Browser Demo

The example configuration enables an anonymous guest demo for one presence
channel. Copy it, start PulseWS, and open <http://127.0.0.1:6001>:

```powershell
Copy-Item pulsews.config.example.json pulsews.config.json
npm run dev
```

Open a second tab to watch the presence roster update and exchange client
events. The `demo` configuration is optional; when omitted, the page and its
restricted guest authorization route are not registered. Demo authorization
is for local compatibility testing, not application identity.

## Roadmap

The implementation plan is intentionally ordered around compatibility gates:

1. Config loader and app credential validation.
2. uWebSockets.js server skeleton and Pusher connection handshake.
3. Public channels, ping/pong, and local event delivery.
4. Signed REST publish endpoint verified against the official Pusher SDK.
5. Private channels, presence channels, and client events.
6. Redis adapter, cluster presence, metrics, Docker Compose, and load tests.

See [docs/pulsews-engineering-doc.md](docs/pulsews-engineering-doc.md) for
protocol and architecture details.

## Scope

PulseWS deliberately does not include a bespoke admin dashboard, webhooks,
database-backed app management, encrypted channels, or clustering beyond Redis
pub/sub. Those are documented as future work so the core compatibility and
scaling story stays focused.

## Repository Map

| Path | Purpose |
|---|---|
| `src/` | TypeScript source |
| `public/` | Opt-in browser demo assets |
| `test/` | Vitest unit and integration tests |
| `docs/pulsews-engineering-doc.md` | Engineering spec |
| `docs/DECISIONS.md` | Architecture decision records |
| `scripts/verify.*` | Local build, lint, and test entrypoints |

## License

[MIT](LICENSE) (c) 2026 Shola Ayeni
