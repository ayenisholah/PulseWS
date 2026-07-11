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

Override host ports with `PULSEWS_HTTP_PORT`, `PROMETHEUS_PORT`, and
`GRAFANA_PORT`. Set `GF_SECURITY_ADMIN_PASSWORD` before exposing Grafana.
Set `PULSEWS_IMAGE` if you need to pin a specific image tag or digest.

## GitHub Actions deployment

The repository now supports an Actions-based image and deployment flow:

1. `container-image.yml` builds the production image on GitHub Actions and
   pushes it to `ghcr.io/ayenisholah/pulsews`.
2. `deploy-production.yml` uploads the `deploy/` bundle to the VPS, then runs
   `docker compose pull` and `docker compose up -d` over SSH.
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

Deploy from the GitHub Actions UI:

1. Run `Container Image` on `main` to publish `ghcr.io/ayenisholah/pulsews:edge`.
2. Run `Deploy Production` with `image_tag=edge` and `run_smoke=true`.
3. Treat a failed smoke job as a failed deployment; inspect the service logs
   before retrying.

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

Open Grafana on port `3000` and sign in with `GF_SECURITY_ADMIN_USER` and
`GF_SECURITY_ADMIN_PASSWORD`. Set a strong password in the VPS environment
before exposing this port. After deployment, verify that Prometheus reports
both targets as **UP** and manually inspect every dashboard panel while the
cluster smoke test is generating traffic.

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
