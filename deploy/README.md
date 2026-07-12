# Compose cluster

The Compose stack runs two PulseWS nodes behind nginx with Redis 7,
Prometheus, and Grafana. Application credentials stay in a host-mounted config
file and are never copied into the image. PulseWS containers are pulled from
GHCR by default, so Docker only needs to exist on the Linux host that runs the
stack.

## Start

```sh
cp deploy/pulsews.config.example.json deploy/pulsews.config.json
# Replace the example secret before exposing the stack.
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

The default endpoints are:

- PulseWS/nginx: <http://127.0.0.1:8080>
- Prometheus: <http://127.0.0.1:9090>
- Grafana: <http://127.0.0.1:3000>
- PulseWS node A diagnostics: <http://127.0.0.1:6002>
- PulseWS node B diagnostics: <http://127.0.0.1:6003>

Override host ports with `PULSEWS_HTTP_PORT`, `PROMETHEUS_PORT`, and
`GRAFANA_PORT`. Set `GF_SECURITY_ADMIN_PASSWORD` before exposing Grafana.
Set `PULSEWS_IMAGE` if you need to pin a specific image tag or digest.

## GitHub Actions deployment

The repository now supports an Actions-based image and deployment flow:

1. `container-image.yml` builds the production image on GitHub Actions and
   pushes it to `ghcr.io/ayenisholah/pulsews`.
2. `deploy-production.yml` requires an explicit immutable image tag, uploads
   the `deploy/` bundle to the VPS, and persists that image in
   `/opt/pulsews/deploy/.env` before running Compose over SSH. The deployment
   fails unless both PulseWS nodes are healthy on the requested tag and the
   same image digest. Mutable `edge` and `latest` tags are rejected.
3. Your Windows machine never needs Docker for this deployment path.

Before the first deploy:

```sh
mkdir -p /opt/pulsews/deploy
cp /path/to/pulsews/deploy/pulsews.config.example.json /opt/pulsews/deploy/pulsews.config.json
# Replace the example app secret and any demo values before exposing the host.
```

GitHub repository secrets required by the deployment workflow:

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_KNOWN_HOSTS`

To enable the post-deploy production smoke gate, also add these secrets to the
`production` environment:

- `PULSEWS_SMOKE_URL` (for example `http://43.106.12.32:8080` until TLS is added)
- `PULSEWS_APP_ID`
- `PULSEWS_APP_KEY`
- `PULSEWS_APP_SECRET`

The first image push creates a GHCR package. Set that package visibility to
public if you want the VPS to pull it without extra registry credentials.

### Deploy a release

Open **Actions -> Deploy Production -> Run workflow**, select `main`, and
enter an immutable tag such as `v0.1.0`. Enable the smoke and failover inputs
when release-gating production. Do not use **Re-run all jobs** to change an
image tag because a rerun retains the original dispatch inputs.

The workflow rejects `edge` and `latest`, writes the requested image to
`/opt/pulsews/deploy/.env`, and verifies both PulseWS containers are healthy
on the requested image and identical digest. Confirm the result on the VPS:

```sh
docker compose -f /opt/pulsews/deploy/docker-compose.yml ps
docker inspect pulsews-pulsews-a-1 pulsews-pulsews-b-1 \
  --format '{{.Name}} {{.Config.Image}} {{.Image}} {{.State.Health.Status}}'
curl -fsS https://your-pulsews-host.example/health
```

The `.env` file is environment state and must not be committed. Future manual
Compose commands automatically reuse its pinned `PULSEWS_IMAGE` value.

Deploy from the GitHub Actions UI:

1. Push a version tag such as `v0.1.0`; `Container Image` publishes the
   matching immutable GHCR tag.
2. Run `Deploy Production` with that version in `image_tag` and enable the
   smoke/failover gates required for the release.
3. Treat a failed smoke job as a failed deployment; inspect the service logs
   before retrying.

For the failover gate, set `run_failover=true`. The workflow keeps two SDK
clients subscribed, stops `pulsews-a`, requires an automatic reconnect and a
post-reconnect signed delivery to both clients, and starts the node again.

## Smoke gate

Use the same app values placed in `deploy/pulsews.config.json`:

```sh
PULSEWS_SMOKE_URL=http://127.0.0.1:8080 \
PULSEWS_APP_ID=demo-app \
PULSEWS_APP_KEY=demo-key \
PULSEWS_APP_SECRET='your-secret' \
npm run smoke:cluster
```

The smoke connects two `pusher-js` clients through nginx, requires distinct
stable node IDs, checks the cross-node presence roster, authorizes both demo
members through nginx, and publishes a signed event through the load balancer
that both clients must receive.

## Metrics and dashboard

Each PulseWS node exposes Prometheus metrics at `/metrics`. Prometheus scrapes
both internal nodes every five seconds. Grafana provisions the **PulseWS
Overview** dashboard automatically in the **PulseWS** folder with panels for:

- connections by application;
- inbound and outbound message throughput;
- same-node and cross-node p50/p99 delivery latency;
- dropped messages by reason;
- client-event rejections; and
- REST publish throttling.

Prometheus and Grafana bind to localhost by default. Access them through an
SSH tunnel and follow the [monitoring guide](../docs/MONITORING.md) for target
checks, dashboard interpretation, retention, and troubleshooting.

Open Grafana on port `3000` and sign in with `GF_SECURITY_ADMIN_USER` and
`GF_SECURITY_ADMIN_PASSWORD`. Set a strong password in the VPS environment
before exposing this port. After deployment, verify that Prometheus reports
both targets as **UP** and manually inspect every dashboard panel while the
cluster smoke test is generating traffic.

Datasource provisioning deletes and recreates the named Prometheus datasource
with the stable `pulsews-prometheus` UID at startup. This intentionally repairs
stale UID/name records in the persistent Grafana database while leaving users,
dashboards, and other state intact.

Inspect service health and logs with:

```sh
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs --tail=100
```

Stop the stack with:

```sh
docker compose -f deploy/docker-compose.yml down
```

Do not add `deploy/pulsews.config.json` to version control. The path is
gitignored and mounted read-only at `/run/secrets/pulsews.config.json`.

## Graceful failover acceptance

Keep the cluster smoke running, then stop one application container (not
nginx or Redis):

```sh
docker compose -f /opt/pulsews/deploy/docker-compose.yml stop pulsews-a
docker compose -f /opt/pulsews/deploy/docker-compose.yml logs --since=2m pulsews-a pulsews-b nginx
redis-cli SCARD pulsews:node:pulsews-a:sockets
```

Clients must receive close code 4200, reconnect through nginx, continue to
receive signed events, and show the correct presence roster. Restart the node
after recording evidence. A failed cleanup must produce a non-zero process
exit status.

## VPS preparation for k6

The load generator and PulseWS currently share the VPS, which must be
disclosed with every result. Before a run, record the existing values, then
raise file descriptors and the ephemeral port range for the test session:

```sh
ulimit -n 200000
sudo sysctl -w net.ipv4.ip_local_port_range='1024 65535'
sudo sysctl -w fs.file-max=500000
docker stats --no-stream
docker compose -f /opt/pulsews/deploy/docker-compose.yml exec redis redis-cli INFO memory
docker compose -f /opt/pulsews/deploy/docker-compose.yml exec redis redis-cli INFO clients
```

Use the commands in `loadtest/README.md`. Monitor `docker stats`, Redis
memory/clients, Prometheus targets, Grafana latency and drop panels, and host
CPU throughout the run. Restore sysctl values afterward if they were intended
to be temporary.

## Host nginx and TLS domain migration

The official public topology is Docker Compose on localhost behind host nginx
and Certbot. To configure `pulsews.sholaayeni.xyz` as the public endpoint:

1. Lower the old DNS TTL, create the new A/AAAA records, and verify they point
   to the VPS.
2. Copy the host nginx vhost, change `server_name`, run `sudo nginx -t`, and
   reload nginx.
3. Run `sudo certbot --nginx -d pulsews.sholaayeni.xyz`, then verify `/health`,
   a WebSocket connection, and the signed cluster smoke over HTTPS.
4. Keep the old name and certificate active during validation. Roll back by
   restoring the previous enabled vhost and DNS record, testing nginx, and
   reloading it.

## Backups, logs, recovery, and rollback

- Back up `/opt/pulsews/deploy/pulsews.config.json`, host nginx configuration,
  certificate renewal configuration, and named Redis/Grafana/Prometheus
  volumes. Encrypt backups because the application config contains secrets.
- Configure Docker log rotation (`max-size` and `max-file`) or journald limits,
  and test that old logs expire. Compose defaults to five 10 MiB JSON log
  files per service.
- Pin `PULSEWS_IMAGE` to an immutable GHCR digest before a release. Roll back
  by restoring the prior digest and running `docker compose pull && docker
  compose up -d`, then rerun the cluster smoke.
- Test recovery by restoring configuration and volumes to a disposable host;
  a backup that has not been restored is not verified.

## Production firewall checklist

Ports 3000 and 9090 may remain public only during the current development
period. Before production readiness, bind their Compose mappings to
`127.0.0.1`, remove their public UFW rules, and verify from another machine
that only SSH, HTTP, and HTTPS are reachable. Use an SSH tunnel for Grafana
and Prometheus. Rotate any application secret exposed in terminal/chat history
and update `PULSEWS_APP_SECRET` in the GitHub production environment before
the final smoke.
