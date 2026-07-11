# Compose cluster

The Compose stack runs two PulseWS nodes behind nginx with Redis 7,
Prometheus, and Grafana. Application credentials stay in a host-mounted config
file and are never copied into the image.

## Start

```sh
cp deploy/pulsews.config.example.json deploy/pulsews.config.json
# Replace the example secret before exposing the stack.
docker compose -f deploy/docker-compose.yml up --build -d
```

The default endpoints are:

- PulseWS/nginx: <http://127.0.0.1:8080>
- Prometheus: <http://127.0.0.1:9090>
- Grafana: <http://127.0.0.1:3000>

Override host ports with `PULSEWS_HTTP_PORT`, `PROMETHEUS_PORT`, and
`GRAFANA_PORT`. Set `GF_SECURITY_ADMIN_PASSWORD` before exposing Grafana.

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
