# k6 load harness

Run these only from the Ubuntu VPS after deploying the Compose cluster. The
defaults are intentionally small; all credentials must refer to the deployed
app and must be passed through the environment, never committed.

```sh
export PULSEWS_URL=https://pulsews.jobrail.xyz
export PULSEWS_APP_ID=demo-app
export PULSEWS_APP_KEY=demo-key
export PULSEWS_APP_SECRET='rotated-secret'

k6 run -e PULSEWS_VUS=500 -e PULSEWS_HOLD_SECONDS=60 loadtest/connection-ramp.js
k6 run -e PULSEWS_RATE=50 -e PULSEWS_DURATION=5m -e PULSEWS_CHANNELS=32 loadtest/rest-latency.js
k6 run -e PULSEWS_VUS=10 -e PULSEWS_ITERATIONS=100 loadtest/cross-node.js
```

Supported overrides are `PULSEWS_URL`, `PULSEWS_APP_ID`,
`PULSEWS_APP_KEY`, `PULSEWS_APP_SECRET`, `PULSEWS_VUS`,
`PULSEWS_DURATION`, `PULSEWS_RATE`, `PULSEWS_CHANNELS`, and the
scenario-specific ramp, hold, iteration, and timeout variables visible in the
scripts. The cross-node scenario publishes through nginx and receives through
a load-balanced WebSocket; confirm that
`pulsews_delivery_latency_seconds_bucket{scope="cross_node"}` increases during
the run. A successful delivery alone does not prove that nginx selected a
different publishing node.

For the measured run, use 1k, 2.5k, 5k, 7.5k, then 10k connections. Stop at
the first unacceptable error rate, CPU saturation, memory pressure, Redis
failure, or latency. Do not extrapolate the next tier.
