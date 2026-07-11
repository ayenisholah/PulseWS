# Load-test report

Status: **500-connection acceptance passed**. This is a small-scale harness
acceptance result, not the final capacity benchmark or a 10,000-connection
claim.

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

The stable maximum remains **not yet measured**. Ramp through 1,000, 2,500,
5,000, 7,500, and 10,000 connections on the target host. Stop when errors,
CPU, memory, Redis health, actionable drops, or latency become unacceptable.

Replace or supplement the current 500-tier Grafana captures with the final
capacity-run view. Include the exact k6 command and stop reason for every tier.
The strict stop condition is any connection/publish failure, dropped message
or iteration, container restart/OOM, Redis error, sustained host CPU above
90%, or publish-to-deliver p99 above 40 ms. The last fully passing tier is the
reported stable maximum.
