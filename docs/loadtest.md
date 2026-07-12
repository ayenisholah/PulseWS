# Load-test report

Status: **7,500 concurrent connections is the measured stable maximum** on
the production two-node VPS topology. The fixed 500-connection acceptance
remains a separate regression gate.

## Required test disclosure

k6 and the PulseWS Compose cluster run on the same VPS. Results therefore
include load-generator contention and must not be presented as isolated
server capacity.

## Acceptance procedure

The fixed acceptance workflow ran the four commands documented in
[the k6 harness](../loadtest/README.md) against the production Compose stack.
It held a 500-connection ramp, sustained 50 signed REST publishes per second
for five minutes, and then checked same-node and cross-node delivery.

## Fixed 500-connection acceptance

| Field | Measured value |
|---|---|
| Result | Passed (`overall_status=0`; all four scenarios exited 0) |
| VPS CPU / RAM / OS | 4 vCPU Intel Xeon Platinum VM, 7.1 GiB RAM, Ubuntu 26.04 LTS |
| Commit | `fca9a4c578c859eb28d7856137e7aaaea99741ea` |
| PulseWS image | `ghcr.io/ayenisholah/pulsews:edge` |
| k6 image | `grafana/k6:2.0.0` (`sha256:a33a0cfdc4d2483d6b7a3a22e726a499ff2831a671a49239104cd34a9937523c`) |
| UTC interval | 2026-07-11 18:24:53–18:32:58 (8m 5s) |
| Connection tier | 500 concurrent connections accepted; 0 failures and 0 dropped iterations |
| WebSocket handshake latency | p50 11 ms, p95 12 ms, p99 15 ms, max 20 ms |
| REST publish load | 15,001 requests at 50/s for 5m; 0 failures |
| REST publish latency | p50 2.32 ms, p95 2.97 ms, p99 4.16 ms, max 15.28 ms |
| Same-node delivery | 100/100 delivered; p50 3 ms, p95 6 ms, p99 7 ms |
| Cross-node delivery | 100/100 delivered; p50 3 ms, p95 6 ms, p99 7 ms |
| Actionable message drops | 0 before and after the run |
| Container state | No restart-count, OOM, or running-state changes during acceptance |
| Prometheus | Both PulseWS targets reported `up=1` after the run |
| Redis | No error/fatal/panic log entries; 1.62 MiB recorded peak memory; 5 clients after the run |
| Postflight resource snapshot | PulseWS A: 0.43% CPU / 31.83 MiB; PulseWS B: 0.45% CPU / 29.84 MiB |

The per-node Redis fan-out path recorded expected `no_local_subscribers`
observations when an event had no listener on one node. These are retained in
the per-reason evidence but excluded from the actionable-drop invariant; the
k6 delivery checks independently confirmed every intended same-node and
cross-node delivery.

The resource figures above are postflight snapshots, not peak CPU or peak
container memory measurements. The Redis peak is reported because Redis
exposes that value directly.

The live observability acceptance captured the full provisioned dashboard
during this run: [upper panels](assets/grafana-load-acceptance-top.png),
[lower panels](assets/grafana-load-acceptance-bottom.png), and
[both Prometheus targets UP](assets/prometheus-targets-up.png). All ten panels
rendered without datasource or query errors. The rejection and throttling
panels correctly had no series because the accepted run recorded neither
condition.

## Final capacity run

The automatic benchmark passed 1,000, 2,500, 5,000, and 7,500 connections.
The exact 10,000 tier reached 10,000 subscriptions but sustained the target
for only 137 seconds before the co-located k6 publisher stalled while
allocating an unplanned VU. It dropped 604 iterations and interrupted 10,009
connection iterations, so the tier failed under the predeclared rules.

| Field | Measured value at the stable maximum |
|---|---|
| Stable maximum | **7,500 concurrent connections and subscriptions**, sustained for 315 seconds |
| VPS CPU / RAM / OS | 4 vCPU Intel Xeon Platinum KVM VM, 7.1 GiB RAM, Ubuntu 26.04 LTS, no swap |
| Commit | `b1a14229932474154fb9e87a4b49c3237052421f` |
| UTC tier interval | 2026-07-12 00:59:53–01:10:51 |
| PulseWS image | `ghcr.io/ayenisholah/pulsews@sha256:0030ec7970d8ccb1470d0cabf0cce7ecc952009d806c9fede04f223ca227aa9c` |
| k6 image | `grafana/k6@sha256:a33a0cfdc4d2483d6b7a3a22e726a499ff2831a671a49239104cd34a9937523c` |
| Capacity path | k6 → VPS-local production nginx (`127.0.0.1:8080`) → two PulseWS nodes; public hostname retained for post-run smoke |
| Signed publish load | 15,001 requests at 50/s for five minutes; 0 failures |
| WebSocket handshake latency | p50 2 ms, p95 2 ms, p99 4 ms, max 14 ms |
| Publish-to-deliver latency | p50 4 ms, p95 6 ms, p99 9 ms, max 45 ms |
| Peak host resources | 44.14% CPU; 5.54 GiB memory used |
| Peak PulseWS containers | A: 21.23% CPU / 56.93 MiB; B: 21.84% CPU / 63.99 MiB |
| Peak nginx / Redis | nginx: 16.96% CPU / 256.90 MiB; Redis: 7.95% CPU / 6.68 MiB (2.38 MiB Redis internal peak) |
| Approximate PulseWS RSS growth | 48.56 MiB across both nodes, about 6.6 KiB per test connection; excludes nginx, Redis, and k6 |
| Failure gates | Both delivery scopes increased; 0 dropped iterations, connection/subscription/publish failures, actionable drops, or throttles |
| Container and Redis health | No restart, OOM, or health-state change; no Redis error/fatal/panic entries |
| Stop reason | 10,000 failed: 604 dropped publisher iterations and insufficient sustained hold after a k6 unplanned-VU allocation error |

The k6 load generator and PulseWS shared this VPS. CPU, memory, latency, and
the 7,500 maximum therefore include load-generator contention. At 10,000,
PulseWS recorded no connection, subscription, publish, or HTTP failures and
delivery p99 remained 12 ms, but the tier still fails because the generator
did not maintain the required workload.

The existing Grafana images above document dashboard acceptance at 500
connections. A historical dashboard capture for the 7,500 UTC interval is
still required before marking milestone M4 complete.
