# Prometheus and Grafana monitoring

The production Compose stack includes Prometheus and Grafana. Prometheus
scrapes both PulseWS nodes every five seconds, and Grafana automatically
provisions the `pulsews-prometheus` datasource and **PulseWS Overview**
dashboard.

## Start and verify monitoring

```sh
docker compose -f /opt/pulsews/deploy/docker-compose.yml up -d prometheus grafana
docker compose -f /opt/pulsews/deploy/docker-compose.yml ps prometheus grafana
curl -fsS http://127.0.0.1:9090/-/healthy
curl -fsS http://127.0.0.1:3000/api/health
```

Prometheus and Grafana bind to `127.0.0.1` by default and should not be opened
directly to the internet. From an operator workstation, create a tunnel:

```sh
ssh -N \
  -L 3000:127.0.0.1:3000 \
  -L 9090:127.0.0.1:9090 \
  user@your-vps
```

Open:

- Grafana: <http://localhost:3000>
- Prometheus targets: <http://localhost:9090/targets>
- Prometheus query UI: <http://localhost:9090/graph>

Set `GF_SECURITY_ADMIN_PASSWORD` in `/opt/pulsews/deploy/.env` before first
production use. Keep that file mode `600`, do not commit it, and rotate the
password if it has been exposed.

## Validate collection

The Prometheus targets page must show both `pulsews-a:6001` and
`pulsews-b:6001` as **UP**. From the VPS:

```sh
curl -fsS 'http://127.0.0.1:9090/api/v1/targets'
curl -fsS 'http://127.0.0.1:6002/metrics'
curl -fsS 'http://127.0.0.1:6003/metrics'
```

The provisioned Grafana dashboard is under **Dashboards -> PulseWS -> PulseWS
Overview**. It covers:

- connections by application;
- inbound and outbound message throughput;
- same-node and cross-node delivery latency;
- dropped messages by reason;
- client-event rejections and REST throttling;
- process resident memory and CPU; and
- event-loop lag.

An empty rejection or throttling panel is expected when no such event occurs.
Missing connection, throughput, resource, or latency data during active
traffic is not expected and should be investigated.

## Operational interpretation

- Rising connection count should agree with application traffic and configured
  connection caps.
- Delivery p99 should be assessed separately for same-node and cross-node
  paths. The `v0.1.0` release gate required p99 below 40 ms.
- Actionable dropped-message reasons, REST throttling, or client-event
  rejection increases require correlation with application and container
  logs. Expected no-local-subscriber observations are documented separately
  in the load-test report.
- Sustained host CPU above 90%, container restarts, unhealthy targets, rising
  event-loop lag, or continuously growing resident memory require operator
  investigation.

See [loadtest.md](loadtest.md) for the exact benchmark thresholds, measured
percentiles, hardware, peak resources, and contention disclosure. Dashboard
screenshots are evidence for those recorded runs, not live guarantees.

## Retention and backups

Prometheus and Grafana data live in the `prometheus-data` and `grafana-data`
named volumes. Back up both volumes before destructive maintenance and prove
the backup by restoring it to a disposable host. Set retention appropriate to
available disk and monitor volume growth; the repository does not prescribe a
universal retention period.

Provisioning files under `deploy/prometheus.yml` and `deploy/grafana/` are the
source-controlled configuration. Dashboard edits made only in the Grafana UI
are not durable across a clean volume replacement unless exported back into
provisioning deliberately.

## Troubleshooting

```sh
docker compose -f /opt/pulsews/deploy/docker-compose.yml logs --tail=200 prometheus grafana
docker compose -f /opt/pulsews/deploy/docker-compose.yml restart prometheus grafana
docker compose -f /opt/pulsews/deploy/docker-compose.yml ps
```

- Target down: verify the PulseWS container is healthy, its `/metrics`
  endpoint responds, and `deploy/prometheus.yml` names the correct service.
- Grafana datasource error: verify Prometheus is healthy and the provisioned
  datasource URL uses the internal Compose service name.
- Dashboard has no traffic data: confirm the time range, both targets, and
  that traffic occurred during the selected interval.
- Tunnel fails: confirm SSH access and that ports 3000/9090 are bound on the
  VPS; do not solve this by exposing them publicly.
- Disk growth: inspect Docker volume usage, choose an explicit retention
  policy, and back up before pruning any monitoring data.
