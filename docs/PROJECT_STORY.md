# PulseWS project story and interview guide

This guide explains why PulseWS exists, how it works, what `v0.1.0` proves,
and how to discuss it accurately with recruiters and engineers.

## Product story

### Aim

PulseWS was built to implement and prove a production-operable, self-hosted
version of the core Pusher Channels protocol. The goal was not to reproduce
every Pusher product feature. It was to preserve the familiar integration
surface for common real-time workloads while demonstrating deployment,
horizontal scaling, security, observability, failure recovery, and measured
capacity.

### Problem solved

Teams using a hosted real-time service can face increasing connection and
message costs or want more control over where and how messaging runs. Moving
away is risky if it requires rewriting browser clients, server publishing,
private-channel authentication, presence behavior, and reconnect handling at
the same time.

PulseWS addresses that migration risk through protocol compatibility. Existing
`pusher-js` clients and the official Pusher Node SDK can use the implemented
surface by changing their connection configuration, while the team operates
the messaging infrastructure. This is a focused migration path, not a
universal drop-in replacement claim.

### Who benefits

- Existing Pusher users evaluating a move to self-hosted infrastructure.
- Backend, platform, DevOps, and full-stack teams that need control over
  WebSocket messaging, private or presence channels, scaling, and operations.
- Engineers studying protocol-compatible distributed systems, authentication,
  shared presence, failure cleanup, and evidence-based capacity testing.

### How it works

Unmodified SDKs connect through nginx, which terminates and balances WebSocket
and REST traffic across PulseWS nodes. PulseWS implements the relevant Pusher
wire protocol, validates application credentials and HMAC signatures, manages
subscriptions, and accepts signed publishes.

Redis coordinates cross-node event fan-out, cluster-wide presence,
connection-cap reservations, socket ownership, and node liveness. Atomic Lua
operations protect presence transitions and cleanup. Prometheus collects
delivery, connection, rejection, resource, and event-loop metrics from both
nodes; Grafana makes those signals visible during acceptance, soak, and
capacity tests.

### Measured outcome

On the documented shared 4-vCPU, 7.1-GiB VPS production topology, PulseWS:

- sustained 7,500 concurrent connections and subscriptions for 315 seconds;
- delivered published events at 9 ms p99 during that stable tier;
- passed a one-hour soak at 3,750 connections with 180,000 accepted publishes
  and 6 ms delivery p99; and
- passed a two-node failover workflow in which clients reconnected, presence
  recovered, and signed delivery continued.

The capacity and soak tests ran k6 on the same VPS as PulseWS, nginx, and
Redis, so the results include load-generator contention. The 10,000-connection
tier is not a passing capacity result: the co-located generator dropped
publisher iterations and did not sustain the required hold. Full hardware,
thresholds, and evidence are in the [load-test report](loadtest.md); failover
acceptance is recorded in the [progress log](PROGRESS.md).

### Boundaries

`v0.1.0` implements core compatibility: protocol 7 connection handling,
public/private/presence channels, client events, and signed REST publishing.
It does not implement webhooks, encrypted channels, a bespoke admin UI, or
every Pusher feature. Redis pub/sub provides at-most-once delivery rather than
durable replay. PulseWS does not claim 10,000 stable connections, performance
on untested hardware, or quantified cost savings.

## Interview-ready formats

### 30-second recruiter pitch

> I built PulseWS to reduce the risk of moving an existing Pusher-based
> application to self-hosted real-time infrastructure. I owned the protocol
> compatibility, security, Redis-backed clustering, production deployment,
> observability, and verification. On a documented shared 4-vCPU VPS, it
> sustained 7,500 concurrent connections with 9 ms delivery p99, passed a
> one-hour 3,750-connection soak, and recovered through a two-node failover.
> I also documented the limits so the results are credible rather than
> overstated.

### Two-minute technical explanation

> I started from the migration constraint: applications should keep using
> `pusher-js` and the official server SDK instead of rewriting every real-time
> integration. I implemented the core Pusher Channels wire behavior, including
> the protocol 7 handshake, channel semantics, client events, and signed REST
> publishing. Private and presence subscriptions use HMAC authentication, with
> constant-time signature checks and validation around channel names, payloads,
> timestamps, and rate limits.
>
> For horizontal scaling, nginx balances traffic across two PulseWS nodes and
> Redis distributes events. Redis also stores presence membership, connection
> reservations, socket ownership, and node heartbeats. Lua operations make
> joins, leaves, and dead-node cleanup atomic so member events remain coherent
> across nodes. Because Redis pub/sub is at-most-once, this design favors live
> messaging latency over durable replay.
>
> I treated operations as part of the product. Both nodes expose Prometheus
> metrics, Grafana visualizes delivery latency and failure signals, and the
> deployment workflow verifies health and image identity. I tested official
> SDK behavior, cross-node delivery, graceful failover, fixed acceptance,
> tiered capacity, and a one-hour soak. The measured stable result was 7,500
> connections at 9 ms delivery p99 on a shared 4-vCPU VPS. Since k6 shared the
> host, I disclose that contention and do not claim the failed 10,000 tier.

### STAR answer

**Situation:** An application using a hosted Pusher-compatible service may
need infrastructure control or a different cost model, but replacing clients,
authentication, publishing, presence, and reconnect behavior together creates
significant migration risk.

**Task:** I took responsibility for proving that the core workflow could run
as a secure, observable, horizontally scaled, self-hosted system while keeping
the familiar SDK integration surface.

**Action:** I implemented protocol-compatible WebSocket and REST behavior,
HMAC authentication, Redis fan-out and atomic distributed presence, node
liveness cleanup, limits, a two-node nginx/Compose deployment, Prometheus and
Grafana monitoring, official-SDK tests, failover gates, and reproducible load
tests.

**Result:** The system sustained 7,500 concurrent connections with 9 ms
delivery p99 on the documented VPS, passed a one-hour 3,750-connection soak,
and passed two-node failover. I rejected the 10,000 tier because the test did
not meet its predefined workload gates.

## Engineering deep dives

### 1. Wire compatibility

Discuss protocol 7 handshakes, event envelopes, subscription state, ping/pong,
channel naming, socket exclusion, and verification with unmodified SDKs. The
key design choice was compatibility at the network boundary rather than a new
client API.

### 2. HMAC authentication

Explain private signatures over `socket_id:channel`, presence signatures that
also bind canonical `channel_data`, and REST signatures over the canonical
request. Mention raw-body MD5 validation, timestamp/replay checks,
constant-time comparison, payload limits, and keeping secrets server-side.

### 3. Distributed presence

Explain why a node-local roster is insufficient behind a load balancer. Redis
hashes record socket membership and ownership; Lua joins and leaves atomically
derive first-user and last-user transitions so the cluster emits coherent
member lifecycle events.

### 4. Failure recovery

Explain stable node IDs, heartbeats, socket records, expired-node sweeping,
and atomic cleanup of leaked reservations and presence. Contrast graceful
shutdown with crash cleanup, then point to the client reconnect and two-node
failover acceptance evidence.

### 5. Capacity benchmarking

Explain predefined pass/fail gates, signed publish traffic during connection
holds, same-node and cross-node delivery measurements, resource and drop
metrics, and why a reached connection count is not automatically a passed
tier. The failed 10,000 run is useful evidence of measurement discipline.

## Honest tradeoffs and what I would improve next

- **At-most-once delivery:** Redis pub/sub is simple and low latency, but it
  does not provide durable replay. I would first clarify workload requirements,
  then evaluate a durable broker only where replay is actually required.
- **Compatibility breadth:** The current evidence covers browser JavaScript
  and the Node server SDK. I would add official-SDK fixtures for more languages
  before broadening compatibility claims.
- **Benchmark isolation:** Co-located k6 competes with the system under test. I
  would move load generation to separate hosts, repeat hardware profiles, and
  investigate the 10,000-tier generator failure.
- **Operations:** I would make backup restoration and disaster-recovery drills
  repeatable, then add bounded retention, alerts, and stronger diagnostics.
- **Feature scope:** I would evaluate signed webhooks and encrypted-channel
  interoperability only with explicit acceptance tests and security review.
- **Distribution:** I would publish multi-architecture images only after native
  dependencies and CI verification are reliable.

These are proposals aligned with the [future releases roadmap](FUTURE_RELEASES.md),
not commitments for a specific release.

## Likely interviewer questions

### Why not build a new WebSocket API?

The migration risk was the point of the project. Preserving the established
SDK and wire boundary lets a team change infrastructure without simultaneously
rewriting clients, publishing, authentication, and presence behavior.

### What makes the project production-operable?

It includes a two-node deployment, TLS/nginx integration, health checks,
limits, graceful shutdown, dead-node cleanup, Prometheus/Grafana monitoring,
immutable-image deployment checks, rollback guidance, failover verification,
and measured acceptance and soak evidence.

### How do you keep presence correct across nodes?

Redis stores membership by socket and node. Atomic Lua operations decide
whether a join is the user's first cluster-wide membership or a leave is the
last, while heartbeat-based cleanup removes state owned by failed nodes.

### What happens if Redis loses a pub/sub message?

That live message is not replayed; delivery is at most once. This is an
intentional `v0.1.0` boundary and makes PulseWS unsuitable for workflows that
require durable delivery without an additional persistence design.

### Why is 7,500 the claimed maximum if 10,000 connected?

The 10,000 tier failed its predefined hold and publisher-iteration gates. A
capacity claim requires the whole workload to pass, not merely reaching the
connection target, so 7,500 is the highest stable measured tier.

### Are the numbers transferable to other hardware?

No. They describe the documented shared 4-vCPU VPS topology, including
co-located k6 contention. Other hardware and deployment shapes require their
own measurements.

### How do you know SDK compatibility works?

The verification suite exercises `pusher-js` behavior and official Pusher Node
SDK signed publishing, while deployment smoke tests cover authentication,
cross-node delivery, presence, and reconnection on the production topology.

### What did you deliberately leave out?

Webhooks, encrypted channels, durable replay, database-backed app management,
a bespoke admin UI, and compatibility claims for untested SDKs. Keeping those
boundaries explicit allowed the core migration, scaling, and operational story
to be tested thoroughly.
