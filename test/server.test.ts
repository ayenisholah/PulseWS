import { createRequire } from "node:module";

import PusherServer from "pusher";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  startAuthServer,
  type RunningAuthServer,
} from "../examples/auth-server/server.js";
import type { PulseWsConfig } from "../src/config.js";
import { MAX_INGRESS_BYTES } from "../src/publish.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
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
  bind: (event: string, callback: (payload: never) => void) => void;
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
    },
  ],
};

const servers: PulseWsServer[] = [];
const authServers: RunningAuthServer[] = [];
const clients: PusherClient[] = [];
const rawSockets: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }

  for (const socket of rawSockets.splice(0)) {
    socket.close();
  }

  for (const server of servers.splice(0)) {
    server.close();
  }

  await Promise.all(authServers.splice(0).map((server) => server.close()));
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
});

describe("public channels", () => {
  test("subscribes, receives published events, and unsubscribes", async () => {
    const server = await startTestServer();
    const client = createClient("demo-key", server.port);

    await waitForConnection(client);
    const channel = client.subscribe("public-updates");

    await waitForChannelEvent(channel, "pusher:subscription_succeeded");

    const delivered = waitForChannelEvent(channel, "demo.event");
    server.publish("demo-app", "public-updates", "demo.event", { ok: true });

    await expect(delivered).resolves.toEqual({ ok: true });

    client.unsubscribe("public-updates");
    await wait(50);

    const unexpectedDelivery = waitForOptionalChannelEvent(
      channel,
      "demo.event.after-unsubscribe",
      150,
    );
    server.publish("demo-app", "public-updates", "demo.event.after-unsubscribe", {
      ok: false,
    });

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
    const authServer = await startAuthServer({
      appKey: "demo-key",
      appSecret: "demo-secret",
      port: 0,
    });
    authServers.push(authServer);
    const client = createClient("demo-key", server.port, {
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
          });
          void fetch(`http://127.0.0.1:${authServer.port}/pusher/auth`, {
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

    await waitForConnection(client);
    const channel = client.subscribe("private-room");

    await expect(
      waitForChannelEvent(channel, "pusher:subscription_succeeded"),
    ).resolves.toEqual({});
    const delivered = waitForChannelEvent(channel, "private.event");
    server.publish("demo-app", "private-room", "private.event", { ok: true });
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
      server.publish("demo-app", "private-room", "private.event", {
        ok: false,
      });
      await expect(unexpectedDelivery).resolves.toBeUndefined();
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
});

async function startTestServer(
  timing?: ServerTimingOptions,
): Promise<PulseWsServer> {
  const server = await startServer(testConfig, timing);
  servers.push(server);
  return server;
}

function connectRawSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/app/demo-key?protocol=7&client=js&version=8.5.0`,
  );
  rawSockets.push(socket);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for raw WebSocket handshake"));
    }, 2_000);

    socket.addEventListener("message", (message) => {
      const parsed = parseRawMessage(message);
      if (parsed.event === "pusher:connection_established") {
        clearTimeout(timeout);
        resolve(socket);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Raw WebSocket connection failed"));
    });
  });
}

function waitForRawEvent(
  socket: WebSocket,
  expectedEvent: string,
): Promise<Record<string, unknown>> {
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
