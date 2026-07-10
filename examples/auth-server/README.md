# Private channel auth example

This dependency-free Node.js server exposes the Pusher-compatible
`POST /pusher/auth` endpoint used by `pusher-js` private channels.

Set credentials that match one application in `pulsews.config.json`, then run:

```powershell
$env:PULSEWS_APP_KEY = "demo-key"
$env:PULSEWS_APP_SECRET = "demo-secret"
npx tsx examples/auth-server/server.ts
```

Point `pusher-js` at the endpoint:

```js
const pusher = new Pusher("demo-key", {
  channelAuthorization: {
    endpoint: "http://127.0.0.1:3001/pusher/auth",
    transport: "ajax",
  },
});
```

The example authorizes every syntactically valid `private-` channel. A real
application must authenticate the caller and check whether that user may join
the requested channel before returning a signature. Keep the application
secret on the server.
