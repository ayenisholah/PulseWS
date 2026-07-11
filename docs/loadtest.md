# Load-test report

Status: **not yet measured**. No benchmark numbers or screenshots are
published because the VPS acceptance run has not been performed in this
workspace.

## Required test disclosure

k6 and the PulseWS Compose cluster run on the same VPS. Results therefore
include load-generator contention and must not be presented as isolated
server capacity.

## Acceptance procedure

Prepare the host using [the deployment runbook](../deploy/README.md), run the
three scripts in [the k6 harness](../loadtest/README.md), and ramp connection
tiers through 1,000, 2,500, 5,000, 7,500, and 10,000. Stop when errors, CPU,
memory, Redis health, drops, or latency become unacceptable.

Record, without estimates:

| Field | Measured value |
|---|---|
| VPS CPU / RAM / Ubuntu version | Pending |
| Image digest and commit | Pending |
| Test UTC start/end and duration | Pending |
| Stable maximum connections | Pending |
| Publish latency p50 / p95 / p99 | Pending |
| Same-node delivery p50 / p99 | Pending |
| Cross-node delivery p50 / p99 | Pending |
| Failed connections / publishes | Pending |
| Dropped messages | Pending |
| Peak CPU / memory | Pending |
| Peak Redis memory / clients | Pending |

Store genuine Grafana captures under `docs/assets/` and link them here only
after the run. Include the exact k6 command and the stop reason for every tier.
The strict stop condition is any connection/publish failure, dropped message
or iteration, container restart/OOM, Redis error, sustained host CPU above
90%, or publish-to-deliver p99 above 40 ms. The last fully passing tier is the
reported stable maximum.
