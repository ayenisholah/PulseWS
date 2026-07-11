# k6 load harness

Run these only from the Ubuntu VPS after deploying the Compose cluster. The
defaults are intentionally small; all credentials must refer to the deployed
app and must be passed through the environment, never committed.

```sh
export PULSEWS_URL=https://pulsews.jobrail.xyz
export PULSEWS_APP_ID=demo-app
export PULSEWS_APP_KEY=demo-key
export PULSEWS_APP_SECRET='rotated-secret'

k6 run --summary-export=connection-500.json -e PULSEWS_VUS=500 -e PULSEWS_HOLD_SECONDS=60 loadtest/connection-ramp.js
k6 run --summary-export=rest-500.json -e PULSEWS_RATE=50 -e PULSEWS_DURATION=5m -e PULSEWS_CHANNELS=32 loadtest/rest-latency.js
k6 run --summary-export=same-node-500.json -e PULSEWS_VUS=10 -e PULSEWS_ITERATIONS=100 -e PULSEWS_EXPECT_SCOPE=same_node -e PULSEWS_NODE_A_URL=http://127.0.0.1:6002 -e PULSEWS_NODE_B_URL=http://127.0.0.1:6002 loadtest/cross-node.js
k6 run --summary-export=cross-node-500.json -e PULSEWS_VUS=10 -e PULSEWS_ITERATIONS=100 -e PULSEWS_EXPECT_SCOPE=cross_node -e PULSEWS_NODE_A_URL=http://127.0.0.1:6002 -e PULSEWS_NODE_B_URL=http://127.0.0.1:6003 loadtest/cross-node.js
k6 run --summary-export=capacity-50.json -e PULSEWS_VUS=50 -e PULSEWS_CHANNELS=100 -e PULSEWS_RATE=50 -e PULSEWS_RAMP_DURATION=15s -e PULSEWS_HOLD_DURATION=30s -e PULSEWS_CONNECTION_SECONDS=50 loadtest/capacity.js
```

Supported overrides are `PULSEWS_URL`, `PULSEWS_APP_ID`,
`PULSEWS_APP_KEY`, `PULSEWS_APP_SECRET`, `PULSEWS_VUS`,
`PULSEWS_DURATION`, `PULSEWS_RATE`, `PULSEWS_CHANNELS`, and the
scenario-specific ramp, hold, iteration, and timeout variables visible in the
scripts. `PULSEWS_NODE_A_URL` and `PULSEWS_NODE_B_URL` select the localhost-only
diagnostic ports. Run the delivery scenario once with both URLs targeting node
A and once publishing to A while receiving from B. Confirm that the Prometheus
`pulsews_delivery_latency_seconds_bucket{scope="cross_node"}` series increases.

For the measured run, use 1k, 2.5k, 5k, 7.5k, then 10k connections. Stop at
the first connection or publish failure, dropped message, dropped iteration,
container restart/OOM, Redis error, sustained host CPU above 90%, or p99
delivery latency above 40 ms. Do not extrapolate the next tier; the last fully
passing tier is the stable maximum.

The `Measured Capacity Benchmark` workflow automates that sequence against
production nginx. It requires the deployed app cap to be exactly 12,000 and
at least 10,000 connections of current headroom. Each tier ramps for five
minutes, holds for five minutes at 50 signed REST publishes/second across 100
public channels, captures five-second resource samples, and uploads a
machine-readable evidence bundle. It stops at the first failure without retry.
