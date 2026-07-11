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
private, and presence channels, rate-limited client events, an opt-in live
browser demo, Redis-backed multi-node event fan-out, cluster-wide presence,
dead-node cleanup, connection caps, REST publish throttling, and a production
Compose cluster verified across two VPS containers. The next step is live
Grafana dashboard acceptance.

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
| Presence channels | Done (single node and Redis cluster) |
| Integrated browser demo | Done |
| Redis fan-out adapter | Done |
| Redis heartbeat and dead-node cleanup | Done |
| Connection caps and REST publish limits | Done |
| Docker Compose cluster | Done; two-node VPS smoke passed |
| Prometheus metrics and Grafana dashboard | Implemented; VPS acceptance pending |
| k6 harness | Implemented; VPS acceptance pending |
| Measured load-test results | Pending; no estimates published |

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

## Architecture

![PulseWS production architecture](docs/architecture.svg)

Host nginx and Certbot terminate public TLS and proxy to the localhost-bound
Compose nginx service. Compose balances WebSockets and REST requests across
two PulseWS nodes. Redis owns event fan-out, presence, connection reservations,
and node liveness; Prometheus and Grafana remain operator-only services.

## Compatibility

| Pusher-compatible surface | Status |
|---|---|
| Protocol 7 connection handshake and ping/pong | Supported |
| Public channels | Supported |
| Private-channel authentication | Supported |
| Presence rosters and member events | Supported |
| Client events on private/presence channels | Supported |
| Official Node SDK signed event publishing | Supported |
| Multi-channel publish and socket exclusion | Supported |
| Webhooks | Not implemented |
| Encrypted channels | Not implemented |

## Development

Requirements:

- Node.js 22+
- npm
- Redis 7 when `redisUrl` is configured
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

When `redisUrl` is omitted, PulseWS uses in-process delivery. When it is
configured, each node opens dedicated Redis publisher and subscriber
connections and subscribes once per app. Events are delivered on every node,
including the publisher, only after the Redis echo. A configured node fails
startup if Redis is unavailable; it never silently falls back to isolated
local delivery.

With Redis configured, presence membership is stored per app and channel in a
Redis hash keyed by socket. Lua join and leave operations make unique-user
rosters and first-join/last-leave events atomic across nodes. Membership
records include the user identity, user info, and owning node ID.

Redis nodes register a 30-second heartbeat refreshed every 10 seconds and keep
persistent socket records. A live peer sweeps expired nodes, removes leaked
presence and connection state atomically, and emits final member-removal
events. Application connection caps are reserved atomically across nodes.

`maxRestPublishesPerSecond` defaults to 100 for each app. PulseWS divides that
allowance by `PULSEWS_CLUSTER_SIZE` and enforces the resulting per-node token
bucket; exhausted requests return HTTP 429 and recover as tokens refill.

The two-node integration test runs when `PULSEWS_TEST_REDIS_URL` is set. CI
provisions Redis 7 and always runs this gate.

## Compose Cluster

The production stack and smoke gate live under [`deploy/`](deploy/README.md).
It runs two stable-ID PulseWS nodes, Redis 7, nginx `least_conn`, Prometheus,
and Grafana. The production image is built in GitHub Actions and pulled from
GHCR, so local Docker is not required on Windows. Copy the external config
example, replace its secret, and follow the deployment README. The M3 cluster
milestone passed on the Ubuntu VPS with distinct-node routing, cross-node
presence, nginx demo authorization, and signed REST delivery.

Prometheus, Grafana, and the two direct node diagnostic ports bind only to
localhost. Use SSH port forwarding for operator access, for example:

```sh
ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 user@your-vps
```

Deployment, TLS migration, secret rotation, backups, rollback, recovery,
firewall, failover, and load-test procedures are documented in the
[deployment runbook](deploy/README.md). The [load-test report](docs/loadtest.md)
will contain only measured results from the target VPS.

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
is for local compatibility testing, not application identity. The example
config enables Redis at `redis://localhost:6379`; remove `redisUrl` for a
single-node local demo without Redis.

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
