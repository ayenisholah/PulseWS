# PulseWS — Engineering Document

**Scalable, Pusher-compatible WebSocket pub/sub server in TypeScript**

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Created** | 2026-07-10 |
| **Target duration** | 2 weeks (MVP shippable at end of week 1) |
| **Repo (planned)** | `pulsews/` — TypeScript server + Docker Compose demo cluster |

---

## Table of contents

1. [Concept & problem statement](#1-concept--problem-statement)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Users and use cases](#3-users-and-use-cases)
4. [Requirements](#4-requirements)
5. [System architecture](#5-system-architecture)
6. [Detailed design](#6-detailed-design)
7. [Technology decisions](#7-technology-decisions)
8. [Operator and demo surfaces](#8-operator-and-demo-surfaces)
9. [Project plan & milestones](#9-project-plan--milestones)
10. [MVP definition](#10-mvp-definition)
11. [Testing & verification strategy](#11-testing--verification-strategy)
12. [Deployment & operations](#12-deployment--operations)
13. [Risks & mitigations](#13-risks--mitigations)
14. [Definition of done & acceptance tests](#14-definition-of-done--acceptance-tests)
15. [Future work](#15-future-work)
16. [Appendix](#16-appendix)

---

## 1. Concept & problem statement

### The idea in one sentence

A self-hosted WebSocket pub/sub server that speaks the **Pusher protocol**, so existing `pusher-js` client apps and Pusher server SDKs work against it unchanged, scaling horizontally across nodes via Redis pub/sub.

### The problem

Hosted real-time services (Pusher, Ably, PubNub) price by concurrent connections and message volume. A product that grows from 500 to 50,000 concurrent users watches its real-time bill grow from pocket change to thousands per month — for what is, architecturally, fan-out over WebSockets. Teams want to bring it in-house, but rewriting every client integration is the blocker.

The escape hatch is **protocol compatibility**: if a self-hosted server implements Pusher's wire protocol (handshake, channels, auth signatures, REST publish API), migration is a config change — point `pusher-js` at a new host, done.

### Why this project exists

- Protocol compatibility is verifiable: the official `pusher-js` SDK either connects and receives events or it does not.
- Redis pub/sub horizontal scaling, HMAC auth, rate limiting, and Prometheus observability are core infrastructure concerns.
- Load-test claims are only useful when the methodology and measured results are committed with the code.

---

## 2. Goals and non-goals

### Goals (binding — from the build spec)

| # | Goal |
|---|---|
| G1 | Pusher protocol core: connection handshake, subscribe/unsubscribe, client events |
| G2 | Public, **private** (HMAC auth), and **presence** channels |
| G3 | Pusher-compatible REST publish API (`POST /apps/:id/events` with request signing) |
| G4 | Redis pub/sub adapter: N server nodes share channels transparently |
| G5 | Per-app credentials from a config file + per-app connection limits and event rate limiting |
| G6 | Prometheus metrics: connections, messages/sec, per-channel counts |
| G7 | k6 load-test script in the repo; measured 10k-connection (or real max) run with p99 latency |

### Non-goals (cut ruthlessly — also binding)

| # | Non-goal | Why it's cut |
|---|---|---|
| N1 | Web dashboard / admin UI | The Grafana dashboard is the UI; a bespoke admin panel adds a week for zero story value |
| N2 | Webhooks (channel_occupied etc.) | Real feature, but orthogonal to the scaling story |
| N3 | Database | App credentials live in a validated config file; state lives in memory + Redis |
| N4 | Encrypted channels (`private-encrypted-`) | Niche Pusher feature; note as future work |
| N5 | Clustering beyond Redis pub/sub | No gossip, no sharding, no sticky routing logic — Redis fan-out is the whole scaling mechanism |

> **Scope rule:** anything not in the Goals table goes to [§15 Future work](#15-future-work) and does not get built.

---

## 3. Users and use cases

### Primary audience

The primary users are developers and operators evaluating whether an existing Pusher-based application can be moved to a self-hosted WebSocket service without rewriting the client or server SDK integration.

### User stories

| ID | Story | Priority |
|---|---|---|
| US1 | As a frontend dev, I point my existing `pusher-js` app at PulseWS by changing only `wsHost`/`wsPort` and everything works | Must |
| US2 | As a backend dev, I publish events with the official Pusher server SDK (or curl with correct signing) and subscribed clients receive them | Must |
| US3 | As a user of a private channel, my subscription is rejected unless my app's auth endpoint signs it | Must |
| US4 | As a presence-channel member, I see who else is in the channel and get join/leave events — even when members are connected to *different* PulseWS nodes | Must |
| US5 | As an operator, I watch connections, message rates, and latency in Grafana while a load test runs | Must |
| US6 | As an operator, one misbehaving app can't take down the node — connection caps and event rate limits apply per app | Should |
| US7 | As a developer evaluating the repo, `docker compose up` gives me a 2-node cluster + Redis + load balancer in one command | Must |

### Demo script (design target)

The 3-minute demo everything must serve: `docker compose up` (2 nodes + Redis + nginx) → open the demo page twice, connected through the LB to *different* nodes (node id shown on page) → both subscribe to a presence channel, each sees the other join → curl the publish API with a signed request → both pages receive the event instantly → start the k6 script → watch Grafana: connections ramp to thousands, p99 latency stays flat → kill node A → clients reconnect through the LB to node B and keep receiving events.

---

## 4. Requirements

### 4.1 Functional requirements

| ID | Requirement | Priority | Acceptance criterion |
|---|---|---|---|
| FR1 | WS endpoint `/app/:key?protocol=7&client=js&version=x` accepting `pusher-js` connections; sends `pusher:connection_established` with `socket_id` and `activity_timeout` | Must | Unmodified `pusher-js` connects and fires `connected` |
| FR2 | `pusher:subscribe` / `pusher:unsubscribe` for public channels; server replies `pusher_internal:subscription_succeeded` | Must | `channel.bind(event, cb)` receives published events |
| FR3 | Private channels (`private-` prefix): validate `auth` field = `key:HMAC-SHA256(secret, socket_id + ":" + channel)` | Must | Valid signature subscribes; tampered signature gets `pusher:error` and no subscription |
| FR4 | Presence channels (`presence-` prefix): auth over `socket_id:channel:channel_data`; deliver member list on subscribe, `pusher_internal:member_added`/`member_removed` on join/leave — consistent across nodes | Must | Two clients on different nodes see each other in `channel.members` |
| FR5 | Client events (`client-` prefix) rebroadcast to other channel subscribers, only on private/presence channels, rate-limited per connection | Must | Client event on public channel rejected; on private channel delivered to peers only |
| FR6 | `pusher:ping`/`pusher:pong` + activity timeout; dead connections reaped | Must | Idle unresponsive socket closed within timeout + grace |
| FR7 | `POST /apps/:app_id/events` with Pusher request signing (`auth_key`, `auth_timestamp`, `auth_version`, `body_md5`, `auth_signature` = HMAC of `POST\n/apps/:id/events\n<sorted query>`); supports `channels[]` and `socket_id` exclusion | Must | Official Pusher Node server SDK publishes successfully; bad signature → 401 |
| FR8 | Redis adapter: events published on any node reach subscribers on all nodes; presence membership stored in Redis so rosters are cluster-wide | Must | 2-node compose: publish to node A, client on node B receives |
| FR9 | Multi-app support from config file (`apps: [{id, key, secret, maxConnections, maxClientEventsPerSecond}]`), zod-validated at boot | Must | Unknown app key → connection refused with correct error code |
| FR10 | Rate limiting: token bucket per connection for client events; per-app cap on REST publishes; per-app connection limit | Must | Exceeding limits → `pusher:error` 4301 / HTTP 429, server stays healthy |
| FR11 | `GET /metrics` Prometheus endpoint: connections (gauge, per app), messages in/out (counters), subscriptions per channel type, publish→deliver latency histogram | Must | Grafana dashboard renders all panels from one scrape target |
| FR12 | Graceful shutdown: stop accepting, close sockets with reconnect-allowed code (4200), drain | Should | Kill during demo → clients auto-reconnect via LB to surviving node |

### 4.2 Non-functional requirements

| ID | Requirement | Target | How measured |
|---|---|---|---|
| NFR1 | Concurrent connections, two-node production cluster | **7,500 measured stable maximum** on the shared 4-vCPU VPS; 10,000 reached but failed the sustained-workload gate | Tiered k6 ramp through VPS-local production nginx |
| NFR2 | p99 publish→deliver latency at max load | **9 ms measured at 7,500**, below the 40 ms target | Timestamps embedded in k6 message payloads |
| NFR3 | Cross-node delivery | Same-node and cross-node Prometheus histograms both increased at every passing tier | Capacity harness against the 2-node Compose cluster |
| NFR4 | Memory per connection | Approx. **6.6 KiB incremental PulseWS RSS per test connection** at 7,500; host peak 5.54 GiB includes co-located k6 | Five-second host and container samples |
| NFR5 | Security | Secrets never sent to clients; HMAC comparisons constant-time; signature timestamps checked (±600 s) to block replay | Code review + negative tests |
| NFR6 | Compatibility | `pusher-js` ≥ v8 and the official `pusher` Node server SDK work unmodified except host/port | The integration test suite runs against both |
| NFR7 | Operability | One-command cluster (`docker compose up`); config errors fail loudly at boot | Manual |

---

## 5. System architecture

### 5.1 Topology

```
pusher-js client ──wss──►┌─────────────┐      ┌──────────────────────────────┐
pusher-js client ──wss──►│  nginx LB   │─────►│ PulseWS node A               │
                         │ (TCP 443,   │      │  uWebSockets.js              │
Backend app / SDK        │  least_conn)│─────►│  ├─ WS handler (protocol 7)  │──┐
  │                      └─────────────┘      │  ├─ channel registry (local) │  │
  │ POST /apps/:id/events (signed)            │  ├─ auth (HMAC)              │  │ Redis
  └──────────────────────────────────────────►│  ├─ rate limiter             │  │ pub/sub +
                                              │  └─ /metrics                 │  │ presence
                                              ├──────────────────────────────┤  │ hashes
                                              │ PulseWS node B (identical)   │──┘
                                              └──────────────────────────────┘
                                                     Prometheus ──► Grafana
```

Every node is stateless except for its local socket set. Channel fan-out across nodes and presence rosters live in Redis. Adding capacity = adding nodes behind the LB.

### 5.2 Components

| Component | Responsibility | Tech |
|---|---|---|
| **WS core** | Accept connections, parse protocol-7 frames, manage socket lifecycle, ping/pong | `uWebSockets.js` |
| **Channel registry** | Local map channel → sockets; subscribe/unsubscribe; local fan-out via uWS topics | in-process `Map` + uWS pub/sub |
| **Auth** | Private/presence subscription signatures; REST request signatures | `node:crypto` HMAC-SHA256, constant-time compare |
| **Redis adapter** | Cross-node event fan-out; cluster-wide presence membership | `ioredis` (separate pub + sub connections) |
| **Publish API** | Signed HTTP endpoint, event validation, size limits | uWS HTTP handlers (same port) |
| **Rate limiter** | Token buckets per connection (client events) and per app (publishes, connections) | in-process, config-driven |
| **Config** | Apps, limits, Redis URL, port — zod-validated at boot | `zod` + JSON/YAML file |
| **Metrics** | Prometheus exposition | `prom-client` |
| **Demo page** | Minimal static page proving compatibility (node id, presence roster, event log) | plain HTML/JS + `pusher-js` from CDN |

### 5.3 Data flow (one published event, cross-node)

1. Backend sends signed `POST /apps/123/events` `{name, channels: ["presence-room"], data}` to any node (via LB).
2. Node verifies the signature (key lookup → HMAC over method/path/sorted-query → constant-time compare, timestamp window check).
3. Node publishes the envelope `{app, channel, event, data, ts, excludeSocket?}` to Redis channel `pulsews:events:<appId>`.
4. Every node (including the publisher) receives it via its Redis subscription and fans out to *local* subscribers of that channel using uWS's topic publish.
5. `pusher-js` clients receive `{event, channel, data}` and fire bound callbacks.
6. Latency histogram observes `now − ts` at delivery (same-host clock for single node; for cross-node numbers, run k6 and nodes on one machine or note clock methodology).

---

## 6. Detailed design

### 6.1 Pusher protocol surface (the compatibility contract)

Implement exactly what `pusher-js` needs — the protocol version 7 subset:

**Connection**: client opens `ws(s)://host/app/{key}?protocol=7&client=js&version=8.4.0`. Server validates the key against configured apps, then sends:

```json
{"event":"pusher:connection_established","data":"{\"socket_id\":\"81107.1634\",\"activity_timeout\":120}"}
```

Note the Pusher quirk: **`data` is a JSON-encoded *string*, not an object** — this applies to most protocol messages and is the #1 compatibility bug to avoid. `socket_id` format is `NNNN.NNNN` (two random integers); clients embed it in auth signatures, so it must be assigned before any subscribe.

**Subscribe** (client → server):

```json
{"event":"pusher:subscribe","data":{"channel":"presence-room","auth":"key:hexsig","channel_data":"{\"user_id\":\"7\",\"user_info\":{...}}"}}
```

**Responses**: `pusher_internal:subscription_succeeded` (for presence, `data` carries `{"presence":{"ids":[...],"hash":{...},"count":N}}`), then `pusher_internal:member_added` / `member_removed` as the roster changes.

**Errors**: `pusher:error` with Pusher's code semantics — 4000–4099 = don't reconnect (e.g. app not found), 4100–4199 = reconnect with backoff (over capacity), 4200–4299 = reconnect immediately (server restarting), 4301 = client event rate limit. Using the right ranges makes `pusher-js` reconnection behave correctly for free.

**Ping/pong**: respond to `pusher:ping` with `pusher:pong`; server-side, mark activity on any inbound frame and close sockets silent past `activity_timeout + 30s`.

**Channel-type rules** (enforced server-side):

| Type | Prefix | Auth required | Client events allowed |
|---|---|---|---|
| Public | (none) | No | No |
| Private | `private-` | Yes | Yes |
| Presence | `presence-` | Yes + `channel_data` | Yes |

### 6.2 Auth signatures

**Subscription auth** (produced by the *customer's* auth endpoint; PulseWS only verifies):

- Private: `signature = HMAC-SHA256(secret, socket_id + ":" + channel)`
- Presence: `signature = HMAC-SHA256(secret, socket_id + ":" + channel + ":" + channel_data)`
- The `auth` field is `"<app_key>:<hex signature>"`. Verify with `crypto.timingSafeEqual`.
- The repo ships a dependency-free Node.js example auth endpoint so demo users don't have to write one.

**REST publish auth** (Pusher HTTP API signing):

```
string_to_sign = "POST\n/apps/{app_id}/events\n" +
  "auth_key={key}&auth_timestamp={ts}&auth_version=1.0&body_md5={md5(body)}"
  (query params sorted lexicographically)
auth_signature = HMAC-SHA256(secret, string_to_sign)
```

Verify: recompute `body_md5` from the raw body, rebuild the sorted query string minus `auth_signature`, HMAC, constant-time compare, and reject timestamps outside ±600 s (replay protection). Getting this byte-exact is what lets the official `pusher` server SDK work — cover it with fixture tests generated *by* that SDK.

### 6.3 Redis adapter

- **Connections**: one `ioredis` client for SUBSCRIBE (dedicated — Redis subscriber connections can't run other commands) and one for PUBLISH + presence commands.
- **Event fan-out**: single Redis channel per app, `pulsews:events:<appId>`. Envelope: `{channel, event, data, excludeSocket, ts, nodeId}`. Every node delivers to local subscribers only. (Per-channel Redis topics are an optimization for sparse subscriptions — note as future work; per-app keeps subscription management trivial for the initial scale target.)
- **Presence state**: Redis hash `pulsews:presence:<appId>:<channel>` mapping `socket_id → channel_data JSON`.
  - On subscribe: `HSET`, read full hash for the roster, publish `member_added` envelope.
  - On disconnect/unsubscribe: `HDEL` + `member_removed` envelope.
  - **Crash safety**: if a node dies without cleanup, its members leak. Mitigation: each node also maintains `pulsews:node:<nodeId>:sockets` (a set) with a 30 s TTL heartbeat; a sweeper on each node removes presence entries belonging to expired nodes.
- **Local echo**: the publishing node delivers via its own Redis subscription rather than short-circuiting — one code path, and cross-node latency shows up honestly in the histogram (tag samples `same_node`/`cross_node` by comparing `nodeId`).

### 6.4 uWebSockets.js specifics

- One `App()` serves both WS (`/app/:key`) and HTTP (`/apps/:id/events`, `/metrics`, static demo page) on one port.
- Use uWS's built-in topic pub/sub for local fan-out: `ws.subscribe(topic)` + `app.publish(topic, payload)` — the C++ layer fans out without touching JS per recipient. Topic = `"<appId>/<channel>"`.
- **Backpressure**: check `ws.getBufferedAmount()` before sends; above 1 MB, drop the message for that socket and increment a `dropped_messages` counter; above 4 MB, close with 4100. Never buffer unboundedly.
- **The uWS footgun**: `ws` objects are invalid after close, and HTTP responses can't be used after `onAborted`. Wrap every async path (auth, Redis) with aborted/closed guards. This is worth a README note — it's the classic uWS crash.
- Payload limits: 10 KB per event (Pusher's own limit), enforced on both WS and REST ingress.

### 6.5 Rate limiting & app limits

- **Client events**: token bucket per connection, default 10 events/s (configurable per app). Empty bucket → `pusher:error` 4301, event dropped, counter incremented. Local-only state (a client is on one node) — no Redis needed.
- **REST publishes**: token bucket per app per node, default `limit / nodeCount` (documented approximation — precise global limiting needs Redis counters; future work).
- **Connection cap**: per-app gauge in Redis (`INCR`/`DECR` on connect/disconnect); at cap, refuse with `pusher:error` 4100 so clients back off. Reconcile the counter from node heartbeat sets on sweep.

### 6.6 Metrics

| Metric | Type | Labels |
|---|---|---|
| `pulsews_connections` | gauge | `app` |
| `pulsews_messages_total` | counter | `app`, `direction` (in/out) |
| `pulsews_subscriptions` | gauge | `app`, `channel_type` |
| `pulsews_publish_latency_seconds` | histogram | `path` (same_node/cross_node) |
| `pulsews_dropped_messages_total` | counter | `app`, `reason` |
| `pulsews_client_event_rejections_total` | counter | `app` |

Repo ships `deploy/grafana/dashboard.json`: connections panel, msg/s panel, p50/p99 latency panel, drops panel.

### 6.7 k6 load test design

- Scenario 1 — **connection ramp**: k6 WS VUs ramp 0 → 10,000 over 5 min against one node, each subscribing to one of 100 public channels, responding to pings. Hold 5 min.
- Scenario 2 — **latency under load**: during the hold, a publisher loop POSTs events (signed) at 50 events/s round-robin across channels, payload embeds `sentAt`; VUs record `now − sentAt` into a k6 Trend → p50/p95/p99 in the summary.
- Scenario 3 — **cross-node**: same harness against the 2-node compose through nginx.
- OS tuning documented in the repo (`ulimit -n`, `net.ipv4.ip_local_port_range`, k6 `--no-connection-reuse` notes) — hitting 10k is usually a client-side file-descriptor problem first; documenting that shows operational maturity.
- **Record the real max** wherever the ramp actually tops out; that number replaces any target-language claims in public docs.

---

## 7. Technology decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| WS library | **uWebSockets.js** | `ws`, Socket.IO | Native C++ core; the only Node option where 10k connections on 2 vCPU is comfortable; built-in topic pub/sub does local fan-out off the JS thread |
| Compatibility target | Pusher protocol 7 | Own protocol, Socket.IO, Ably | "Your existing clients work unchanged" is the entire commercial story; verifiable with the official SDKs |
| Scaling bus | Redis pub/sub | NATS, Kafka, uWS-only | At-most-once fan-out is exactly Pusher's own semantics; ubiquitous, one Compose service; matches the job-post keyword |
| Presence store | Redis hashes + node-heartbeat sweeper | Redis-only local, CRDTs, gossip | Simplest thing that survives a node crash, with the failure mode documented |
| Config | zod-validated file | Postgres, env-only | N3 says no DB; zod gives boot-time failure with readable errors |
| Language/runtime | TypeScript on Node 22+ | Rust, Go | Matches the target client/server SDK ecosystem and keeps protocol tests close to the official Node SDKs |
| Load testing | k6 | artillery, custom | First-class WS support, Trend metrics for latency, single binary in CI |
| Demo cluster | Docker Compose: 2 nodes + Redis + nginx + Prometheus + Grafana | k8s | `docker compose up` is the strongest possible quickstart; k8s adds nothing to the story |
| Metrics | prom-client + Grafana | StatsD, custom | Prometheus is the industry default and Grafana gives operators a live view during load tests |

---

## 8. Operator and demo surfaces

### 8.1 Surfaces

PulseWS is a server, so the user-facing surfaces are operational and
compatibility-focused:

1. **Demo page** (`/` on each node): connection status, node id badge, presence roster, live event log, and a small publish/client-event control surface.
2. **Grafana dashboard**: live connections, message rates, latency, drops, and client-event rejections.
3. **README**: current implementation status, quickstart once available, compatibility table, architecture summary, and measured load-test results.

### 8.2 Demo page requirements

The demo page must stay dependency-light and easy to inspect:

- Vanilla HTML/CSS/JS served by the same uWS port.
- `pusher-js` loaded from a CDN for browser compatibility proof.
- Shows connection state, assigned node id, presence members, and a timestamped event log.
- Includes controls for sending client events once private/presence channels exist.
- Displays only live data from the running server; no hardcoded performance counters.
- Demo routes are opt-in through configuration and include a guest presence
  authorization endpoint restricted to the configured demo app and channel.

### 8.3 Design acceptance

- [ ] Demo page connects with `pusher-js` from the browser and shows live connection status.
- [ ] Node-id badge is legible in local and load-balanced runs.
- [ ] Presence roster and event log update from real protocol messages.
- [ ] README embeds an architecture diagram only after the diagram matches the implemented topology.

---

## 9. Project plan & milestones

2 weeks, ~15–20 focused hours/week. Compatibility first (verify against real `pusher-js` from day 2), scale second.

### Week 1 — single node, full protocol *(→ MVP)*

| Day | Work |
|---|---|
| 1 | Repo scaffold (TS, tsup/tsx, vitest), zod config loader, uWS server skeleton, `/app/:key` handshake → `pusher:connection_established`; verify `pusher-js` reaches `connected` |
| 2 | Public channels: subscribe/unsubscribe, local registry on uWS topics, ping/pong + activity reaper |
| 3 | REST publish API with full Pusher request-signature verification (fixture tests generated with the official `pusher` SDK); event delivery to subscribers |
| 4 | Private channels (HMAC verify + example auth endpoint); client events with per-connection token bucket |
| 5 | Presence channels (roster, member_added/removed — local, in-memory); demo page v1. **Checkpoint = MVP (§10): full protocol on one node, verified with official SDKs** |

### Week 2 — Redis scaling, observability, load test, publish

| Day | Work |
|---|---|
| 1 | Redis adapter: event fan-out envelope, per-app channels, local-echo-via-Redis; presence state moved to Redis hashes |
| 2 | Node heartbeat sets + presence sweeper; per-app connection caps in Redis; Docker Compose (2 nodes + Redis + nginx + Prometheus + Grafana) |
| 3 | prom-client metrics + Grafana dashboard JSON; graceful shutdown (4200 close codes); failover demo working |
| 4 | k6 scripts (ramp, latency, cross-node); OS tuning; run the real 10k attempt, record actual max + p99; capture the Grafana screenshot |
| 5 | Deploy one node publicly (VPS + Caddy TLS); README (GIF, diagram, compatibility table, quickstart, load-test writeup) updated with measured numbers |

### Milestone gates

| Gate | Criterion | If missed |
|---|---|---|
| M1 (W1D3) | `pusher-js` + official server SDK both work against one node | Stop and fix — compatibility is the project; nothing else matters until this passes |
| M2 (end W1) | **MVP**: all three channel types + client events + rate limiting, single node | Presence can slip 2 days into W2; private channels cannot |
| M3 (W2D2) | Cross-node delivery + cluster presence working in Compose | Ship single-node + document the adapter design as in-progress; don't fake the demo |
| M4 (end W2) | Load-tested, deployed, README complete with real numbers | Publish with the honest measured max even if < 10k; never publish unmeasured claims |

**M4 status: Passed.** The deployed two-node cluster has a measured stable
maximum of 7,500 concurrent connections, documented latency and resource
peaks, public demo and operations guidance, and retained Grafana evidence.

---

## 10. MVP definition

**MVP = the smallest thing that proves the thesis:** the official Pusher SDKs work unchanged against my server.

**In the MVP (end of Week 1):**
- Handshake + public/private/presence channels + client events, single node
- Pusher-signed REST publish API
- Per-connection client-event rate limiting, per-app config
- Demo page; verified against unmodified `pusher-js` and the `pusher` Node SDK

**Explicitly *not* in the MVP (Week 2):** Redis adapter, cluster presence, connection caps, metrics/Grafana, Compose cluster, k6 numbers, public deployment.

**Blessed degraded MVP** (if Week 1 slips): public + private channels only, presence deferred — still demos compatibility and auth, the two hardest claims.

---

## 11. Testing & verification strategy

| Layer | What | How |
|---|---|---|
| Unit | Signature verification (subscription + REST, fixtures generated by official SDKs), token bucket, config validation, envelope codec | Vitest |
| Protocol integration | Real `pusher-js` in Node (`ws` shim) against a spawned server: connect, subscribe each channel type, receive publishes, auth rejections, rate-limit errors, ping timeout | Vitest + child process |
| Cluster integration | Compose 2 nodes + Redis: cross-node delivery, cluster presence roster, node-kill → sweeper cleans presence, reconnect through LB | Vitest with `testcontainers` (or a shell harness against Compose) |
| Negative/security | Tampered signatures, stale `auth_timestamp` (replay), oversized payloads, client events on public channels, unknown app key | Vitest table-driven |
| Load | k6 scenarios (§6.7); pass/fail = server stays up, drops bounded, p99 recorded | Manual on the VPS, results committed to `docs/loadtest.md` |
| Soak | 1 h at 50 % of max connections, memory flat | Manual + Grafana |

CI (GitHub Actions): typecheck + unit + protocol-integration on every push; cluster tests behind a label (need Docker).

---

## 12. Deployment & operations

- **Demo cluster** = Docker Compose (the primary artifact): `pulsews-a`, `pulsews-b`, `redis:7-alpine`, `nginx` (least_conn, WS upgrade headers), `prometheus`, `grafana` (provisioned dashboard). One command, full story.
- **Public node**: VPS (2 vCPU — deliberately, so the load-test claim is honest), Caddy on 443 terminating TLS → PulseWS on localhost. Redis local to the box. systemd unit, `Restart=on-failure`.
- **OS tuning** (documented in `deploy/README`): `nofile` limits for the service, `sysctl` port range for the k6 box.
- **Config**: `pulsews.config.json` mounted/env-pointed; secrets kept out of git (example file committed).
- **Logs**: pino JSON to stdout/journald.
- **Rollback**: previous image tag / previous binary; server is stateless so rollback is instant.

---

## 13. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Protocol quirks break `pusher-js` (stringified `data`, socket_id format, error codes) | High | High | Test against the real SDK from day 2; fixture tests generated by official SDKs; M1 gate blocks everything else |
| R2 | uWS async footguns (use-after-abort crashes) | Medium | High | Aborted/closed guards on every async path; soak test; documented in code |
| R3 | 10k target missed on 2 vCPU (or blocked by client-side limits) | Medium | Medium (credibility) | Tune OS first, distinguish client vs server bottleneck, publish the honest measured max — parent doc explicitly requires replacing targets with measurements |
| R4 | Presence consistency bugs across nodes (leaked members after crash) | Medium | Medium | Heartbeat-set sweeper (§6.3); a dedicated kill-a-node integration test |
| R5 | Redis pub/sub message loss during Redis restart | Low | Low | At-most-once is Pusher's own semantic; state it in the README rather than engineering around it |
| R6 | Scope creep (dashboard UI, webhooks) | High | Medium | §2 non-goals binding; ideas go to §15 |
| R7 | 2-week estimate slips | Medium | Medium | Milestone gates with pre-decided cuts; degraded MVP pre-authorized |

---

## 14. Definition of done & acceptance tests

Ship when **all** pass (mirrors + extends the parent spec's DoD):

1. **Compatibility**: unmodified `pusher-js` (browser, via the public URL) connects, subscribes to all three channel types, and receives events published by the official `pusher` Node SDK — with only host/port overridden.
2. **Cross-node**: in the Compose cluster, a client on node A receives an event published through node B; presence roster is correct when members span nodes.
3. **Failover**: killing one node mid-demo → clients reconnect via the LB and continue receiving; leaked presence entries swept within 60 s.
4. **Auth**: tampered subscription signature and tampered REST signature both rejected; stale timestamp rejected.
5. **Limits**: client-event flood → 4301 errors, server healthy; app over connection cap → 4100.
6. **Load test**: k6 run completed and written up in `docs/loadtest.md` with real max connections + p50/p99 latency; Grafana screenshot captured.
7. **One public node** deployed behind TLS with the demo page live.
8. **README**: demo GIF → architecture diagram → compatibility table (what's implemented vs Pusher) → `docker compose up` quickstart → load-test writeup.
9. **Public documentation updated**: measured numbers replace target language, and README links to the load-test writeup and public demo.

---

## 15. Future work (explicitly deferred)

- Webhooks (`channel_occupied`, `member_added` → customer endpoints)
- Encrypted channels (`private-encrypted-`, shared-secret payload encryption)
- Per-channel Redis topics (sparse-subscription optimization) + precise global rate limits via Redis counters
- Watchlist/user-authentication (Pusher's newer `user` events)
- Horizontal presence via Redis Streams for at-least-once member events
- Admin/observability UI (channel browser, live connection table)
- Soketi-style benchmark comparison writeup

---

## 16. Appendix

### 16.1 Planned repo layout

```
pulsews/
├── src/
│   ├── index.ts            # boot: config → server → adapter → metrics
│   ├── config.ts           # zod schema + loader
│   ├── server.ts           # uWS app: WS behavior + HTTP routes
│   ├── protocol.ts         # pusher message frames (stringified-data quirk lives here)
│   ├── channels.ts         # registry, channel-type rules, subscribe/unsubscribe
│   ├── presence.ts         # roster ops (Redis hashes) + sweeper
│   ├── auth.ts             # subscription HMAC + REST request signing verify
│   ├── adapter/
│   │   ├── local.ts        # single-node adapter (week 1)
│   │   └── redis.ts        # pub/sub fan-out + heartbeats (week 2)
│   ├── ratelimit.ts        # token buckets
│   └── metrics.ts          # prom-client registry
├── public/                 # demo page (vanilla JS + pusher-js CDN)
├── examples/auth-server/   # Node.js subscription-auth endpoint
├── test/                   # vitest: unit, protocol, cluster
├── loadtest/               # k6 scripts + docs/loadtest.md template
├── deploy/                 # docker-compose.yml, nginx.conf, prometheus.yml,
│                           # grafana dashboard JSON, Caddyfile, systemd unit
└── docs/                   # this doc, architecture.png
```

### 16.2 Key package list

`uWebSockets.js`, `ioredis`, `zod`, `prom-client`, `pino`, dev: `typescript`, `tsx`, `vitest`, `pusher-js` + `pusher` (test-side, for compatibility fixtures), `k6` (binary), `testcontainers` (optional).

### 16.3 Release evidence checklist

- [x] Grafana screenshot during load test showing connection ramp and latency.
- [x] Real max connections plus p50/p99 latency recorded in `docs/loadtest.md`.
- [x] Architecture diagram embedded in README after it matches the implemented topology.
- [x] Public demo link documented once the deployed node is live.

### 16.4 Glossary

| Term | Meaning |
|---|---|
| **Pusher protocol** | The JSON-over-WebSocket wire protocol used by Pusher Channels and its client SDKs (version 7 here) |
| **Presence channel** | Channel whose subscribers carry identity (`user_id`/`user_info`) and see a live member roster |
| **Client event** | Event published directly by a client (`client-` prefix), allowed only on authenticated channels |
| **Socket id** | Per-connection identifier (`NNNN.NNNN`) embedded in auth signatures and publish exclusions |
| **Adapter** | The fan-out backend: local (in-process) or Redis (cluster-wide) |
| **Token bucket** | Rate limiter: capacity + refill rate; a request spends a token or is rejected |
| **at-most-once** | Delivery semantic where messages may be lost but never duplicated (Redis pub/sub, and Pusher itself) |
