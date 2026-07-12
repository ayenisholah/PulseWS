# Installation and usage

PulseWS requires Node.js 22 or newer. Redis 7 is optional for a single node
and required for shared presence, connection reservations, and delivery
across multiple nodes.

## Local installation

```sh
git clone https://github.com/ayenisholah/PulseWS.git
cd PulseWS
npm install
cp pulsews.config.example.json pulsews.config.json
npm run dev
```

PowerShell users can create the config with:

```powershell
Copy-Item pulsews.config.example.json pulsews.config.json
```

Replace `apps[].secret` before exposing the server. Generate a secret on
Linux/macOS with `openssl rand -hex 32`, or use a trusted password generator.
Never put the secret in browser code or commit `pulsews.config.json`.

The example expects Redis at `redis://localhost:6379`. Remove `redisUrl` for
single-node in-memory delivery. Verify startup at:

```sh
curl http://127.0.0.1:6001/health
```

## Configuration

PulseWS reads `pulsews.config.json` unless `PULSEWS_CONFIG` points elsewhere.

```json
{
  "port": 6001,
  "redisUrl": "redis://localhost:6379",
  "apps": [
    {
      "id": "my-app",
      "key": "public-app-key",
      "secret": "replace-with-a-long-random-secret",
      "maxConnections": 1000,
      "maxClientEventsPerSecond": 10,
      "maxRestPublishesPerSecond": 100
    }
  ]
}
```

The app ID and secret are server-side credentials. The app key is public and
is used by browser clients. `maxConnections` is cluster-wide when Redis is
configured. REST capacity is divided across `PULSEWS_CLUSTER_SIZE` nodes.

## Browser client

Install the unmodified Pusher client:

```sh
npm install pusher-js
```

```js
import Pusher from "pusher-js";

const pusher = new Pusher("public-app-key", {
  cluster: "mt1",
  wsHost: "pulsews.example.com",
  wssPort: 443,
  forceTLS: true,
  enabledTransports: ["ws", "wss"],
  disableStats: true,
  channelAuthorization: { endpoint: "/pusher/auth" },
});

const channel = pusher.subscribe("private-orders");
channel.bind("order.updated", (event) => console.log(event));
```

Use `wsHost: "127.0.0.1"`, `wsPort: 6001`, and `forceTLS: false` for local
development. Public channels need no authorization endpoint.

## Server publishing

Install the official server SDK:

```sh
npm install pusher
```

```js
import Pusher from "pusher";

const pusher = new Pusher({
  appId: "my-app",
  key: "public-app-key",
  secret: process.env.PULSEWS_APP_SECRET,
  host: "pulsews.example.com",
  port: 443,
  useTLS: true,
});

await pusher.trigger("private-orders", "order.updated", { id: "order-42" });
```

## Private and presence authentication

Your application—not PulseWS—must authenticate the signed-in user and return
a Pusher-compatible channel authorization response. A complete Node example
is in [`examples/auth-server`](../examples/auth-server/README.md).

- Private channels sign `socket_id:channel_name`.
- Presence channels also include JSON `channel_data` with `user_id` and
  optional `user_info`.
- Client events must begin with `client-` and work only on subscribed private
  or presence channels.

Never allow a browser to choose an arbitrary user ID without validating its
application session first.

## Redis and multiple nodes

Set the same config on every node, give each process a unique
`PULSEWS_NODE_ID`, and set `PULSEWS_CLUSTER_SIZE` to the intended node count.
All nodes must use the same Redis instance. If configured Redis is
unavailable, startup fails instead of silently falling back to isolated local
delivery.

For the supported two-node production topology, use the
[deployment runbook](../deploy/README.md) instead of assembling the cluster
manually.

## Verification and troubleshooting

```sh
npm run verify
curl http://127.0.0.1:6001/health
curl http://127.0.0.1:6001/metrics
```

- Connection failure: check the app key, host, port, TLS, and nginx WebSocket
  upgrade headers.
- HTTP 401: check app ID/key/secret, clock synchronization, and SDK host/TLS
  settings.
- Subscription failure: verify the exact socket ID, channel name, signature,
  and presence `channel_data`.
- Cross-node delivery failure: check Redis and both Prometheus targets.
- HTTP 429 or client error 4301: reduce traffic or intentionally adjust the
  corresponding configured limit.

See the [production runbook](../deploy/README.md) for container logs,
failover, backup, and rollback procedures. See the
[monitoring guide](MONITORING.md) for Prometheus and Grafana setup and use.
