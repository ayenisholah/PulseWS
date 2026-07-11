import { createRequire } from "node:module";

import PusherServer from "pusher";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  startAuthServer,
  type RunningAuthServer,
} from "../examples/auth-server/server.js";
import {
  createPresenceChannelAuth,
  verifyPresenceChannelAuth,
} from "../src/auth.js";
import type { PulseWsConfig } from "../src/config.js";
import { MAX_INGRESS_BYTES } from "../src/publish.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
  CONNECTION_LIMIT_ERROR_CODE,
  GRACEFUL_SHUTDOWN_CLOSE_CODE,
  readClusterSize,
  resolveNodeId,
  startServer,
  type PulseWsServer,
  type ServerTimingOptions,
} from "../src/server.js";

const require = createRequire(import.meta.url);
const Pusher = (require("pusher-js") as { Pusher: PusherConstructor }).Pusher;

type PusherConstructor = new (key: string, options: Record<string, unknown>) => PusherClient;

type PusherClient = {
  connection: {
    socket_id: string;
    bind: (event: string, callback: (payload: never) => void) => void;
  };
  subscribe: (channel: string) => PusherChannel;
  unsubscribe: (channel: string) => void;
  disconnect: () => void;
};

type PusherChannel = {
  bind: (
    event: string,
    callback: (payload: never, metadata?: { user_id?: string }) => void,
  ) => void;
  trigger: (event: string, data: unknown) => boolean;
  members: {
    count: number;
    me: { id: string; info: Record<string, unknown> } | null;
    get: (id: string) =>
      | { id: string; info: Record<string, unknown> }
      | null;
  };
};

const testConfig: PulseWsConfig = {
  port: 0,
  apps: [
    {
      id: "demo-app",
      key: "demo-key",
      secret: "demo-secret",
      maxConnections: 100,
      maxClientEventsPerSecond: 10,
      maxRestPublishesPerSecond: 100,
    },
  ],
};

const servers: PulseWsServer[] = [];
const authServers: RunningAuthServer[] = [];
const clients: PusherClient[] = [];
const rawSockets: WebSocket[] = [];
const rawSocketIds = new WeakMap<WebSocket, string>();
const rawNodeMessages = new WeakMap<WebSocket, Record<string, unknown>>();

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }

  for (const socket of rawSockets.splice(0)) {
    socket.close();
  }

  await Promise.all([
    ...servers.splice(0).map((server) => server.close()),
    ...authServers.splice(0).map((server) => server.close()),
  ]);
});

describe("uWS server handshake", () => {
  test("connects unmodified pusher-js clients with a valid app key", async () => {
    const server = await startTestServer();
    const client = createClient("demo-key", server.port);

    const connected = await waitForConnection(client);

    expect(connected.socketId).toMatch(/^\d+\.\d+$/);
  });

  test("refuses unknown app keys with pusher error 4001", async () => {
    const server = await startTestServer();
    const client = createClient("unknown-key", server.port);

    await expect(waitForError(client)).resolves.toMatchObject({
      error: {
        data: {
          code: APP_NOT_FOUND_CLOSE_CODE,
        },
      },
    });
  });

  test("identifies the WebSocket node after connection", async () => {
    const server = await startTestServer();
    const socket = await connectRawSocket(server.port);

    const identified = await waitForRawEvent(socket, "pulsews:node");
    expect(JSON.parse(String(identified.data))).toEqual({
      node_id: server.nodeId,
    });
  });

  test("exposes a health check with the active node id", async () => {
    const server = await startTestServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      nodeId: server.nodeId,
    });
  });

  test("graceful shutdown is idempotent and closes clients with code 4200", async () => {
    const server = await startTestServer();
    const socket = await connectRawSocket(server.port);
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });

    const firstClose = server.close();
    expect(server.close()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(closed).resolves.toMatchObject({
      code: GRACEFUL_SHUTDOWN_CLOSE_CODE,
    });
    await expect(fetch(`http://127.0.0.1:${server.port}/health`)).rejects.toThrow();
  });

  test("exposes connection, subscription, rejection, and throttle metrics", async () => {
    const server = await startServer({
      ...testConfig,
      apps: testConfig.apps.map((app) => ({
        ...app,
        maxRestPublishesPerSecond: 1,
      })),
    });
    servers.push(server);
    const socket = await connectRawSocket(server.port);
    const subscribed = waitForRawEvent(
      socket,
      "pusher_internal:subscription_succeeded",
    );
    socket.send(
      JSON.stringify({
        event: "pusher:subscribe",
        data: { channel: "public-metrics" },
      }),
    );
    await subscribed;
    const rejected = waitForRawEvent(socket, "pusher:error");
    socket.send(
      JSON.stringify({
        event: "client-invalid",
        channel: "public-metrics",
        data: {},
      }),
    );
    await rejected;

    const sdk = createServerSdk(server.port);
    expect((await sdk.trigger("public-metrics", "accepted", {})).status).toBe(
      200,
    );
    await expect(
      sdk.trigger("public-metrics", "throttled", {}),
    ).rejects.toMatchObject({ status: 429 });

    const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const exposition = await response.text();
    expect(exposition).toContain('pulsews_connections{app_id="demo-app"} 1');
    expect(exposition).toContain(
      'pulsews_subscriptions{app_id="demo-app",channel_type="public"} 1',
    );
    expect(exposition).toContain("pulsews_process_resident_memory_bytes");
    expect(exposition).toContain("pulsews_process_cpu_seconds_total");
    expect(exposition).toContain("pulsews_nodejs_eventloop_lag_p99_seconds");
    expect(exposition).toContain(
      'pulsews_client_event_rejections_total{app_id="demo-app",reason="invalid_channel"} 1',
    );
    expect(exposition).toContain(
      'pulsews_rest_throttled_total{app_id="demo-app"} 1',
    );
    expect(exposition).toContain(
      'pulsews_delivery_latency_seconds_count{app_id="demo-app",scope="same_node"} 1',
    );
    expect(exposition).toContain(
      'pulsews_messages_total{app_id="demo-app",direction="out"} 1',
    );

    const closed = waitForRawClose(socket);
    socket.close();
    await closed;
    await wait(25);
    const afterClose = await (
      await fetch(`http://127.0.0.1:${server.port}/metrics`)
    ).text();
    expect(afterClose).toContain('pulsews_connections{app_id="demo-app"} 0');
    expect(afterClose).toContain(
      'pulsews_subscriptions{app_id="demo-app",channel_type="public"} 0',
    );
  });

  test("refuses connections over the app cap and releases clean disconnects", async () => {
    const server = await startServer({
      ...testConfig,
      apps: testConfig.apps.map((app) => ({ ...app, maxConnections: 1 })),
    });
    servers.push(server);
    const first = await connectRawSocket(server.port);
    const second = openRawSocket(server.port);
    const unexpectedEstablished = waitForOptionalRawEvent(
      second,
      "pusher:connection_established",
      100,
    );
    const refused = await waitForRawEvent(second, "pusher:error");
    expect(JSON.parse(String(refused.data))).toMatchObject({
      code: CONNECTION_LIMIT_ERROR_CODE,
    });
    await expect(unexpectedEstablished).resolves.toBeUndefined();

    const firstClosed = waitForRawClose(first);
    first.close();
    await firstClosed;
    await wait(25);

    await expect(connectRawSocket(server.port)).resolves.toBeDefined();
  });
});

describe("integrated demo mode", () => {
  test("serves safe assets and configuration only when enabled", async () => {
    const disabled = await startTestServer();
    expect((await fetch(`http://127.0.0.1:${disabled.port}/`)).status).toBe(404);

    const server = await startDemoServer();
    const [page, styles, script, config, favicon, socialCard, manifest, robots, sitemap] = await Promise.all([
      fetch(`http://127.0.0.1:${server.port}/`),
      fetch(`http://127.0.0.1:${server.port}/styles.css`),
      fetch(`http://127.0.0.1:${server.port}/demo.js`),
      fetch(`http://127.0.0.1:${server.port}/demo/config`),
      fetch(`http://127.0.0.1:${server.port}/favicon.svg`),
      fetch(`http://127.0.0.1:${server.port}/og-pulsews.png`),
      fetch(`http://127.0.0.1:${server.port}/site.webmanifest`),
      fetch(`http://127.0.0.1:${server.port}/robots.txt`),
      fetch(`http://127.0.0.1:${server.port}/sitemap.xml`),
    ]);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(styles.headers.get("content-type")).toContain("text/css");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
    expect(socialCard.headers.get("content-type")).toContain("image/png");
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    expect(socialCard.headers.get("cache-control")).toContain("public");
    expect((await socialCard.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
    await expect(manifest.json()).resolves.toMatchObject({ short_name: "PulseWS" });
    expect(await robots.text()).toContain("Sitemap: https://pulsews.jobrail.xyz/sitemap.xml");
    expect(await sitemap.text()).toContain("https://pulsews.jobrail.xyz/");
    await expect(config.json()).resolves.toEqual({
      appKey: "demo-key",
      channel: "presence-demo",
    });
    expect(await page.text()).not.toContain("demo-secret");
    expect(await styles.text()).not.toContain("demo-secret");
    expect(await script.text()).not.toContain("demo-secret");
  });

  test("authorizes guests only for the configured demo channel", async () => {
    const server = await startDemoServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/demo/auth`, {
      method: "POST",
      body: new URLSearchParams({
        socket_id: "123.456",
        channel_name: "presence-demo",
        user_id: "guest-123",
        user_info: JSON.stringify({ name: "Guest 123" }),
      }),
    });
    expect(response.status).toBe(200);
    const authorization = (await response.json()) as {
      auth: string;
      channel_data: string;
    };
    expect(
      verifyPresenceChannelAuth(
        { key: "demo-key", secret: "demo-secret" },
        "123.456",
        "presence-demo",
        authorization.channel_data,
        authorization.auth,
      ),
    ).toBe(true);

    const rejected = await fetch(`http://127.0.0.1:${server.port}/demo/auth`, {
      method: "POST",
      body: new URLSearchParams({
        socket_id: "123.456",
        channel_name: "presence-other",
        user_id: "guest-123",
      }),
    });
    expect(rejected.status).toBe(403);
  });
});

describe("public channels", () => {
  test("subscribes, receives published events, and unsubscribes", async () => {
    const server = await startTestServer();
    const client = createClient("demo-key", server.port);

    await waitForConnection(client);
    const channel = client.subscribe("public-updates");

    await waitForChannelEvent(channel, "pusher:subscription_succeeded");

    const delivered = waitForChannelEvent(channel, "demo.event");
    await server.publish("demo-app", "public-updates", "demo.event", {
      ok: true,
    });

    await expect(delivered).resolves.toEqual({ ok: true });

    client.unsubscribe("public-updates");
    await wait(50);

    const unexpectedDelivery = waitForOptionalChannelEvent(
      channel,
      "demo.event.after-unsubscribe",
      150,
    );
    await server.publish(
      "demo-app",
      "public-updates",
      "demo.event.after-unsubscribe",
      { ok: false },
    );

    await expect(unexpectedDelivery).resolves.toBeUndefined();
  });

  test("delivers an official SDK publish to an unmodified pusher-js client", async () => {
    const server = await startTestServer();
    const client = createClient("demo-key", server.port);
    const sdk = createServerSdk(server.port);

    await waitForConnection(client);
    const channel = client.subscribe("public-updates");
    await waitForChannelEvent(channel, "pusher:subscription_succeeded");
    const delivered = waitForChannelEvent(channel, "sdk.event");

    const response = await sdk.trigger("public-updates", "sdk.event", {
      nested: { ok: true },
    });

    expect(response.status).toBe(200);
    await expect(delivered).resolves.toEqual({ nested: { ok: true } });
  });

  test("delivers one official SDK publish to multiple channels", async () => {
    const server = await startTestServer();
    const client = createClient("demo-key", server.port);
    const sdk = createServerSdk(server.port);

    await waitForConnection(client);
    const first = client.subscribe("channel-one");
    const second = client.subscribe("channel-two");
    await Promise.all([
      waitForChannelEvent(first, "pusher:subscription_succeeded"),
      waitForChannelEvent(second, "pusher:subscription_succeeded"),
    ]);
    const deliveries = [
      waitForChannelEvent(first, "multi.event"),
      waitForChannelEvent(second, "multi.event"),
    ];

    const response = await sdk.trigger(
      ["channel-one", "channel-two"],
      "multi.event",
      { ok: true },
    );

    expect(response.status).toBe(200);
    await expect(Promise.all(deliveries)).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  test("excludes only the requested socket from an official SDK publish", async () => {
    const server = await startTestServer();
    const excludedClient = createClient("demo-key", server.port);
    const receivingClient = createClient("demo-key", server.port);
    const sdk = createServerSdk(server.port);

    const [{ socketId }] = await Promise.all([
      waitForConnection(excludedClient),
      waitForConnection(receivingClient),
    ]);
    const excludedChannel = excludedClient.subscribe("shared-channel");
    const receivingChannel = receivingClient.subscribe("shared-channel");
    await Promise.all([
      waitForChannelEvent(excludedChannel, "pusher:subscription_succeeded"),
      waitForChannelEvent(receivingChannel, "pusher:subscription_succeeded"),
    ]);
    const excludedDelivery = waitForOptionalChannelEvent(
      excludedChannel,
      "excluded.event",
      250,
    );
    const receivedDelivery = waitForChannelEvent(
      receivingChannel,
      "excluded.event",
    );

    const response = await sdk.trigger(
      "shared-channel",
      "excluded.event",
      { ok: true },
      { socket_id: socketId },
    );

    expect(response.status).toBe(200);
    await expect(receivedDelivery).resolves.toEqual({ ok: true });
    await expect(excludedDelivery).resolves.toBeUndefined();
  });
});

describe("private channels", () => {
  test("authorizes an unmodified pusher-js client through the example endpoint", async () => {
    const server = await startTestServer();
    const authServer = await startTestAuthServer();
    const client = createAuthorizedClient(server.port, authServer.port);

    await waitForConnection(client);
    const channel = client.subscribe("private-room");

    await expect(
      waitForChannelEvent(channel, "pusher:subscription_succeeded"),
    ).resolves.toEqual({});
    const delivered = waitForChannelEvent(channel, "private.event");
    await server.publish("demo-app", "private-room", "private.event", {
      ok: true,
    });
    await expect(delivered).resolves.toEqual({ ok: true });
  });

  test("rejects missing or tampered authorization without subscribing", async () => {
    const server = await startTestServer();

    for (const auth of [undefined, `demo-key:${"0".repeat(64)}`]) {
      const socket = await connectRawSocket(server.port);
      const error = waitForRawEvent(socket, "pusher:error");
      const data = {
        channel: "private-room",
        ...(auth === undefined ? {} : { auth }),
      };

      socket.send(JSON.stringify({ event: "pusher:subscribe", data }));

      await expect(error).resolves.toMatchObject({ event: "pusher:error" });
      const unexpectedDelivery = waitForOptionalRawEvent(
        socket,
        "private.event",
        150,
      );
      await server.publish("demo-app", "private-room", "private.event", {
        ok: false,
      });
      await expect(unexpectedDelivery).resolves.toBeUndefined();
    }
  });
});

describe("client events", () => {
  test("delivers private client events to peers but not the sender", async () => {
    const server = await startTestServer();
    const authServer = await startTestAuthServer();
    const sender = createAuthorizedClient(server.port, authServer.port);
    const peer = createAuthorizedClient(server.port, authServer.port);

    await Promise.all([waitForConnection(sender), waitForConnection(peer)]);
    const senderChannel = sender.subscribe("private-room");
    const peerChannel = peer.subscribe("private-room");
    await Promise.all([
      waitForChannelEvent(senderChannel, "pusher:subscription_succeeded"),
      waitForChannelEvent(peerChannel, "pusher:subscription_succeeded"),
    ]);
    const peerDelivery = waitForChannelEvent(peerChannel, "client-message");
    const senderDelivery = waitForOptionalChannelEvent(
      senderChannel,
      "client-message",
      150,
    );

    expect(senderChannel.trigger("client-message", { text: "hello" })).toBe(
      true,
    );

    await expect(peerDelivery).resolves.toEqual({ text: "hello" });
    await expect(senderDelivery).resolves.toBeUndefined();
  });

  test("rejects client events on public and unsubscribed channels", async () => {
    const server = await startTestServer();
    const publicPeer = createClient("demo-key", server.port);
    await waitForConnection(publicPeer);
    const publicChannel = publicPeer.subscribe("public-room");
    await waitForChannelEvent(publicChannel, "pusher:subscription_succeeded");

    const publicSender = await connectRawSocket(server.port);
    const publicSubscribed = waitForRawEvent(
      publicSender,
      "pusher_internal:subscription_succeeded",
    );
    publicSender.send(
      JSON.stringify({
        event: "pusher:subscribe",
        data: { channel: "public-room" },
      }),
    );
    await publicSubscribed;

    const publicError = waitForRawEvent(publicSender, "pusher:error");
    const publicDelivery = waitForOptionalChannelEvent(
      publicChannel,
      "client-public",
      150,
    );
    publicSender.send(
      JSON.stringify({
        event: "client-public",
        channel: "public-room",
        data: { rejected: true },
      }),
    );
    await expect(publicError).resolves.toMatchObject({ event: "pusher:error" });
    await expect(publicDelivery).resolves.toBeUndefined();

    const unsubscribedSender = await connectRawSocket(server.port);
    const unsubscribedError = waitForRawEvent(unsubscribedSender, "pusher:error");
    unsubscribedSender.send(
      JSON.stringify({
        event: "client-private",
        channel: "private-room",
        data: { rejected: true },
      }),
    );
    await expect(unsubscribedError).resolves.toMatchObject({
      event: "pusher:error",
    });
  });

  test("rate limits floods with 4301 and recovers after refill", async () => {
    const lowRateConfig: PulseWsConfig = {
      ...testConfig,
      apps: testConfig.apps.map((app) => ({
        ...app,
        maxClientEventsPerSecond: 2,
      })),
    };
    const server = await startServer(lowRateConfig);
    servers.push(server);
    const authServer = await startTestAuthServer();
    const sender = createAuthorizedClient(server.port, authServer.port);
    const peer = createAuthorizedClient(server.port, authServer.port);

    await Promise.all([waitForConnection(sender), waitForConnection(peer)]);
    const senderChannel = sender.subscribe("private-room");
    const peerChannel = peer.subscribe("private-room");
    await Promise.all([
      waitForChannelEvent(senderChannel, "pusher:subscription_succeeded"),
      waitForChannelEvent(peerChannel, "pusher:subscription_succeeded"),
    ]);

    const first = waitForChannelEvent(peerChannel, "client-first");
    const second = waitForChannelEvent(peerChannel, "client-second");
    const limited = waitForConnectionError(sender);
    senderChannel.trigger("client-first", { sequence: 1 });
    senderChannel.trigger("client-second", { sequence: 2 });
    senderChannel.trigger("client-third", { sequence: 3 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sequence: 1 },
      { sequence: 2 },
    ]);
    await expect(limited).resolves.toMatchObject({
      data: { code: 4301 },
    });

    await wait(600);
    const recovered = waitForChannelEvent(peerChannel, "client-recovered");
    senderChannel.trigger("client-recovered", { healthy: true });
    await expect(recovered).resolves.toEqual({ healthy: true });
  });
});

describe("presence channels", () => {
  test("maintains pusher-js rosters across join, unsubscribe, and disconnect", async () => {
    const server = await startTestServer();
    const authServer = await startTestAuthServer();
    const ada = createAuthorizedClient(server.port, authServer.port, {
      userId: "user-1",
      userInfo: { name: "Ada" },
    });
    const grace = createAuthorizedClient(server.port, authServer.port, {
      userId: "user-2",
      userInfo: { name: "Grace" },
    });

    await Promise.all([waitForConnection(ada), waitForConnection(grace)]);
    const adaChannel = ada.subscribe("presence-room");
    await waitForChannelEvent(adaChannel, "pusher:subscription_succeeded");
    expect(adaChannel.members.count).toBe(1);
    expect(adaChannel.members.me).toEqual({
      id: "user-1",
      info: { name: "Ada" },
    });

    const added = waitForChannelEvent(adaChannel, "pusher:member_added");
    let graceChannel = grace.subscribe("presence-room");
    await waitForChannelEvent(graceChannel, "pusher:subscription_succeeded");
    await expect(added).resolves.toEqual({
      id: "user-2",
      info: { name: "Grace" },
    });
    expect(graceChannel.members.count).toBe(2);
    expect(graceChannel.members.get("user-1")).toEqual({
      id: "user-1",
      info: { name: "Ada" },
    });

    const removedOnUnsubscribe = waitForChannelEvent(
      adaChannel,
      "pusher:member_removed",
    );
    grace.unsubscribe("presence-room");
    await expect(removedOnUnsubscribe).resolves.toEqual({
      id: "user-2",
      info: { name: "Grace" },
    });
    expect(adaChannel.members.count).toBe(1);

    const readded = waitForChannelEvent(adaChannel, "pusher:member_added");
    graceChannel = grace.subscribe("presence-room");
    await waitForChannelEvent(graceChannel, "pusher:subscription_succeeded");
    await readded;
    const removedOnDisconnect = waitForChannelEvent(
      adaChannel,
      "pusher:member_removed",
    );
    grace.disconnect();
    await expect(removedOnDisconnect).resolves.toMatchObject({ id: "user-2" });
    expect(adaChannel.members.count).toBe(1);
  });

  test("adds sender identity metadata to presence client events", async () => {
    const server = await startTestServer();
    const authServer = await startTestAuthServer();
    const sender = createAuthorizedClient(server.port, authServer.port, {
      userId: "user-1",
      userInfo: { name: "Ada" },
    });
    const peer = createAuthorizedClient(server.port, authServer.port, {
      userId: "user-2",
      userInfo: { name: "Grace" },
    });

    await Promise.all([waitForConnection(sender), waitForConnection(peer)]);
    const senderChannel = sender.subscribe("presence-room");
    const peerChannel = peer.subscribe("presence-room");
    await Promise.all([
      waitForChannelEvent(senderChannel, "pusher:subscription_succeeded"),
      waitForChannelEvent(peerChannel, "pusher:subscription_succeeded"),
    ]);
    const delivered = waitForChannelEventWithMetadata(
      peerChannel,
      "client-status",
    );
    const echoed = waitForOptionalChannelEvent(
      senderChannel,
      "client-status",
      150,
    );

    senderChannel.trigger("client-status", { online: true });

    await expect(delivered).resolves.toEqual({
      payload: { online: true },
      metadata: { user_id: "user-1" },
    });
    await expect(echoed).resolves.toBeUndefined();
  });

  test("rejects invalid presence authorization and identity data", async () => {
    const server = await startTestServer();

    for (const invalid of ["signature", "identity"] as const) {
      const client = createClient("demo-key", server.port, {
        channelAuthorization: {
          customHandler: (
            params: { socketId: string; channelName: string },
            callback: (
              error: Error | null,
              authorization: { auth: string; channel_data: string } | null,
            ) => void,
          ) => {
            const channelData =
              invalid === "identity"
                ? JSON.stringify({ user_id: "" })
                : JSON.stringify({ user_id: "user-1" });
            callback(null, {
              channel_data: channelData,
              auth:
                invalid === "signature"
                  ? `demo-key:${"0".repeat(64)}`
                  : createPresenceChannelAuth(
                      { key: "demo-key", secret: "demo-secret" },
                      params.socketId,
                      params.channelName,
                      channelData,
                    ),
            });
          },
        },
      });

      await waitForConnection(client);
      const rejected = waitForConnectionError(client);
      client.subscribe("presence-room");
      await expect(rejected).resolves.toMatchObject({ data: { code: 4000 } });
    }
  });

  test("removes an idle presence member when the reaper closes it", async () => {
    const server = await startTestServer({
      activityTimeoutSeconds: 0.08,
      activityGraceSeconds: 0.08,
      reaperIntervalMilliseconds: 10,
    });
    const observer = await connectRawSocket(server.port);
    await subscribeRawPresence(observer, "user-observer");
    const keepObserverActive = setInterval(() => {
      observer.send(JSON.stringify({ event: "observer:activity", data: {} }));
    }, 40);

    try {
      const idle = await connectRawSocket(server.port);
      const added = waitForRawEvent(observer, "pusher_internal:member_added");
      await subscribeRawPresence(idle, "user-idle");
      await added;
      const removed = waitForRawEvent(
        observer,
        "pusher_internal:member_removed",
      );
      const closed = waitForRawClose(idle, 500);

      await expect(closed).resolves.toBeUndefined();
      await expect(removed).resolves.toMatchObject({
        event: "pusher_internal:member_removed",
      });
    } finally {
      clearInterval(keepObserverActive);
    }
  });
});

describe("connection liveness", () => {
  test("responds to pusher ping messages with pusher pong", async () => {
    const server = await startTestServer();
    const socket = await connectRawSocket(server.port);

    const pong = waitForRawEvent(socket, "pusher:pong");
    socket.send(JSON.stringify({ event: "pusher:ping", data: "{}" }));

    await expect(pong).resolves.toEqual({
      event: "pusher:pong",
      data: "{}",
    });
  });

  test("reaps an idle unresponsive socket after timeout plus grace", async () => {
    const server = await startTestServer({
      activityTimeoutSeconds: 0.05,
      activityGraceSeconds: 0.05,
      reaperIntervalMilliseconds: 10,
    });
    const socket = await connectRawSocket(server.port);
    const closed = waitForRawClose(socket, 250);

    await wait(60);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await expect(closed).resolves.toBeUndefined();
  });

  test("refreshes activity on every inbound frame", async () => {
    const server = await startTestServer({
      activityTimeoutSeconds: 0.08,
      activityGraceSeconds: 0.08,
      reaperIntervalMilliseconds: 10,
    });
    const socket = await connectRawSocket(server.port);
    const closed = waitForRawClose(socket);

    await wait(100);
    socket.send("not json");
    await wait(80);

    expect(socket.readyState).toBe(WebSocket.OPEN);
    await expect(closed).resolves.toBeUndefined();
  });

  test("accepts a 10 KB frame, closes one byte over, and remains usable", async () => {
    const server = await startTestServer();
    const socket = await connectRawSocket(server.port);

    socket.send(createSizedFrame(MAX_INGRESS_BYTES));
    await wait(50);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const closed = waitForRawClose(socket);
    socket.send(`${createSizedFrame(MAX_INGRESS_BYTES)}x`);
    await expect(closed).resolves.toBeUndefined();

    const client = createClient("demo-key", server.port);
    await expect(waitForConnection(client)).resolves.toMatchObject({
      socketId: expect.stringMatching(/^\d+\.\d+$/),
    });
  });
});

describe("signed REST publish authentication", () => {
  test("accepts publishes from the unmodified official Pusher SDK", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);

    const response = await sdk.trigger(
      "public-updates",
      "demo.event",
      { ok: true },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  test("rejects an SDK-generated request with a tampered signature", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);
    const body = createPublishBody();
    const signedQuery = sdk.createSignedQueryString({
      method: "POST",
      path: "/apps/demo-app/events",
      body,
    });
    const tamperedQuery = signedQuery.replace(
      /auth_signature=[0-9a-f]+/,
      `auth_signature=${"0".repeat(64)}`,
    );

    const response = await postSignedRequest(server.port, tamperedQuery, body);

    expect(response.status).toBe(401);
  });

  test("rejects a correctly signed stale SDK request", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);
    const body = createPublishBody();
    const currentTime = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(currentTime - 601_000);
    let signedQuery: string;
    try {
      signedQuery = sdk.createSignedQueryString({
        method: "POST",
        path: "/apps/demo-app/events",
        body,
      });
    } finally {
      dateNow.mockRestore();
    }

    const response = await postSignedRequest(server.port, signedQuery, body);

    expect(response.status).toBe(401);
  });

  test("returns 401 for an unknown app id", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);
    const body = createPublishBody();
    const path = "/apps/unknown-app/events";
    const signedQuery = sdk.createSignedQueryString({
      method: "POST",
      path,
      body,
    });

    const response = await fetch(
      `http://127.0.0.1:${server.port}${path}?${signedQuery}`,
      { method: "POST", body },
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 for malformed authenticated publish payloads", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);
    const malformedBodies = [
      JSON.stringify({ name: "", channels: ["valid"], data: "{}" }),
      JSON.stringify({ name: "event", channels: [], data: "{}" }),
      JSON.stringify({ name: "event", channels: ["bad channel"], data: "{}" }),
      JSON.stringify({ name: "event", channels: ["valid"], data: {} }),
      JSON.stringify({
        name: "event",
        channels: ["valid"],
        data: "{}",
        socket_id: "invalid",
      }),
      "not json",
    ];

    for (const body of malformedBodies) {
      const response = await postSdkSignedBody(server.port, sdk, body);
      expect(response.status).toBe(400);
    }
  });

  test("accepts exactly 10 KB, rejects one byte over, and remains usable", async () => {
    const server = await startTestServer();
    const sdk = createServerSdk(server.port);

    const exactResponse = await postSdkSignedBody(
      server.port,
      sdk,
      createSizedPublishBody(MAX_INGRESS_BYTES),
    );
    expect(exactResponse.status).toBe(200);

    const oversizedResponse = await postSdkSignedBody(
      server.port,
      sdk,
      createSizedPublishBody(MAX_INGRESS_BYTES + 1),
    );
    expect(oversizedResponse.status).toBe(413);

    const healthyResponse = await sdk.trigger(
      "public-updates",
      "after-oversize.event",
      { ok: true },
    );
    expect(healthyResponse.status).toBe(200);
  });

  test("divides REST allowance by cluster size, returns 429, and recovers", async () => {
    const previousClusterSize = process.env.PULSEWS_CLUSTER_SIZE;
    process.env.PULSEWS_CLUSTER_SIZE = "2";
    let server: PulseWsServer;
    try {
      server = await startServer({
        ...testConfig,
        apps: testConfig.apps.map((app) => ({
          ...app,
          maxRestPublishesPerSecond: 4,
        })),
      });
    } finally {
      if (previousClusterSize === undefined) {
        delete process.env.PULSEWS_CLUSTER_SIZE;
      } else {
        process.env.PULSEWS_CLUSTER_SIZE = previousClusterSize;
      }
    }
    servers.push(server);
    const sdk = createServerSdk(server.port);

    expect((await sdk.trigger("public-rate", "one", {})).status).toBe(200);
    expect((await sdk.trigger("public-rate", "two", {})).status).toBe(200);
    await expect(
      sdk.trigger("public-rate", "three", {}),
    ).rejects.toMatchObject({ status: 429 });

    await wait(550);
    expect((await sdk.trigger("public-rate", "recovered", {})).status).toBe(
      200,
    );
  });
});

describe("cluster sizing", () => {
  test("defaults to one and validates positive integer overrides", () => {
    expect(readClusterSize(undefined)).toBe(1);
    expect(readClusterSize("3")).toBe(3);
    for (const invalid of ["0", "-1", "1.5", "not-a-number"]) {
      expect(() => readClusterSize(invalid)).toThrow(
        "PULSEWS_CLUSTER_SIZE must be a positive integer",
      );
    }
  });

  test("accepts stable node ids and rejects empty overrides", () => {
    expect(resolveNodeId("pulsews-a")).toBe("pulsews-a");
    expect(resolveNodeId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => resolveNodeId("   ")).toThrow(
      "PULSEWS_NODE_ID must contain 1 to 100 characters",
    );
  });
});

async function startTestServer(
  timing?: ServerTimingOptions,
): Promise<PulseWsServer> {
  const server = await startServer(testConfig, timing);
  servers.push(server);
  return server;
}

async function startDemoServer(): Promise<PulseWsServer> {
  const server = await startServer({
    ...testConfig,
    demo: { appKey: "demo-key", channel: "presence-demo" },
  });
  servers.push(server);
  return server;
}

async function startTestAuthServer(): Promise<RunningAuthServer> {
  const server = await startAuthServer({
    appKey: "demo-key",
    appSecret: "demo-secret",
    port: 0,
  });
  authServers.push(server);
  return server;
}

function connectRawSocket(port: number): Promise<WebSocket> {
  const socket = openRawSocket(port);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for raw WebSocket handshake"));
    }, 2_000);

    socket.addEventListener("message", (message) => {
      const parsed = parseRawMessage(message);
      if (parsed.event === "pusher:connection_established") {
        const connectionData = JSON.parse(String(parsed.data)) as {
          socket_id: string;
        };
        rawSocketIds.set(socket, connectionData.socket_id);
        clearTimeout(timeout);
        resolve(socket);
      }
      if (parsed.event === "pulsews:node") {
        rawNodeMessages.set(socket, parsed);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Raw WebSocket connection failed"));
    });
  });
}

function openRawSocket(port: number): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/app/demo-key?protocol=7&client=js&version=8.5.0`,
  );
  rawSockets.push(socket);
  return socket;
}

async function subscribeRawPresence(
  socket: WebSocket,
  userId: string,
): Promise<void> {
  const socketId = rawSocketIds.get(socket);
  if (!socketId) {
    throw new Error("Raw socket id is unavailable");
  }
  const channel = "presence-room";
  const channelData = JSON.stringify({ user_id: userId, user_info: {} });
  const subscribed = waitForRawEvent(
    socket,
    "pusher_internal:subscription_succeeded",
  );
  socket.send(
    JSON.stringify({
      event: "pusher:subscribe",
      data: {
        channel,
        channel_data: channelData,
        auth: createPresenceChannelAuth(
          { key: "demo-key", secret: "demo-secret" },
          socketId,
          channel,
          channelData,
        ),
      },
    }),
  );
  await subscribed;
}

function waitForRawEvent(
  socket: WebSocket,
  expectedEvent: string,
): Promise<Record<string, unknown>> {
  if (expectedEvent === "pulsews:node") {
    const cached = rawNodeMessages.get(socket);
    if (cached) {
      return Promise.resolve(cached);
    }
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedEvent}`));
    }, 2_000);

    socket.addEventListener("message", (message) => {
      const parsed = parseRawMessage(message);
      if (parsed.event === expectedEvent) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForOptionalRawEvent(
  socket: WebSocket,
  expectedEvent: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);

    socket.addEventListener("message", (message) => {
      const parsed = parseRawMessage(message);
      if (parsed.event === expectedEvent) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForRawClose(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for raw WebSocket close"));
    }, timeoutMs);

    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function parseRawMessage(message: MessageEvent): Record<string, unknown> {
  return JSON.parse(String(message.data)) as Record<string, unknown>;
}

function createClient(
  key: string,
  port: number,
  options: Record<string, unknown> = {},
): PusherClient {
  const client = new Pusher(key, {
    cluster: "mt1",
    wsHost: "127.0.0.1",
    wsPort: port,
    forceTLS: false,
    enabledTransports: ["ws"],
    disableStats: true,
    ...options,
  });
  clients.push(client);
  return client;
}

function createAuthorizedClient(
  serverPort: number,
  authServerPort: number,
  presenceMember?: {
    userId: string;
    userInfo?: Record<string, unknown>;
  },
): PusherClient {
  return createClient("demo-key", serverPort, {
    channelAuthorization: {
      customHandler: (
        params: { socketId: string; channelName: string },
        callback: (
          error: Error | null,
          authorization: { auth: string } | null,
        ) => void,
      ) => {
        const body = new URLSearchParams({
          socket_id: params.socketId,
          channel_name: params.channelName,
          ...(presenceMember === undefined
            ? {}
            : {
                user_id: presenceMember.userId,
                user_info: JSON.stringify(presenceMember.userInfo ?? {}),
              }),
        });
        void fetch(`http://127.0.0.1:${authServerPort}/pusher/auth`, {
          method: "POST",
          body,
        })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`Authorization failed with ${response.status}`);
            }
            return (await response.json()) as { auth: string };
          })
          .then(
            (authorization) => callback(null, authorization),
            (error: unknown) =>
              callback(
                error instanceof Error ? error : new Error(String(error)),
                null,
              ),
          );
      },
    },
  });
}

function createServerSdk(port: number): PusherServer {
  return new PusherServer({
    appId: "demo-app",
    key: "demo-key",
    secret: "demo-secret",
    host: "127.0.0.1",
    port: String(port),
    useTLS: false,
  });
}

function createPublishBody(): string {
  return JSON.stringify({
    name: "demo.event",
    channels: ["public-updates"],
    data: JSON.stringify({ ok: true }),
  });
}

function createSizedPublishBody(size: number): string {
  const base = JSON.stringify({
    name: "demo.event",
    channels: ["public-updates"],
    data: "{}",
    padding: "",
  });
  const paddingLength = size - Buffer.byteLength(base);
  if (paddingLength < 0) {
    throw new Error("Requested publish body is too small");
  }

  const sized = JSON.stringify({
    name: "demo.event",
    channels: ["public-updates"],
    data: "{}",
    padding: "x".repeat(paddingLength),
  });
  if (Buffer.byteLength(sized) !== size) {
    throw new Error("Unable to create exact publish body size");
  }
  return sized;
}

function createSizedFrame(size: number): string {
  const base = JSON.stringify({ event: "ignored", data: "" });
  const paddingLength = size - Buffer.byteLength(base);
  if (paddingLength < 0) {
    throw new Error("Requested WebSocket frame is too small");
  }

  const sized = JSON.stringify({
    event: "ignored",
    data: "x".repeat(paddingLength),
  });
  if (Buffer.byteLength(sized) !== size) {
    throw new Error("Unable to create exact WebSocket frame size");
  }
  return sized;
}

function postSdkSignedBody(
  port: number,
  sdk: PusherServer,
  body: string,
): Promise<Response> {
  const signedQuery = sdk.createSignedQueryString({
    method: "POST",
    path: "/apps/demo-app/events",
    body,
  });
  return postSignedRequest(port, signedQuery, body);
}

function postSignedRequest(
  port: number,
  signedQuery: string,
  body: string,
): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${port}/apps/demo-app/events?${signedQuery}`,
    { method: "POST", body },
  );
}

function waitForConnection(client: PusherClient): Promise<{ socketId: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for pusher-js connected state"));
    }, 2_000);

    client.connection.bind("connected", () => {
      clearTimeout(timeout);
      resolve({
        socketId: client.connection.socket_id,
      });
    });

    client.connection.bind("error", (error: unknown) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForError(
  client: PusherClient,
): Promise<{ error?: { data?: { code?: number } } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for pusher-js error"));
    }, 2_000);

    client.connection.bind(
      "error",
      (error: { error?: { data?: { code?: number } } }) => {
        clearTimeout(timeout);
        resolve(error);
      },
    );

    client.connection.bind("connected", () => {
      clearTimeout(timeout);
      reject(new Error("Unexpectedly connected with unknown app key"));
    });
  });
}

function waitForConnectionError(client: PusherClient): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for pusher-js connection error"));
    }, 2_000);

    client.connection.bind("error", (error: unknown) => {
      clearTimeout(timeout);
      resolve(error);
    });
  });
}

function waitForChannelEvent(
  channel: PusherChannel,
  event: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);

    channel.bind(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function waitForChannelEventWithMetadata(
  channel: PusherChannel,
  event: string,
): Promise<{ payload: unknown; metadata: { user_id?: string } | undefined }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);

    channel.bind(event, (payload, metadata) => {
      clearTimeout(timeout);
      resolve({ payload, metadata });
    });
  });
}

function waitForOptionalChannelEvent(
  channel: PusherChannel,
  event: string,
  timeoutMs: number,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);

    channel.bind(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
