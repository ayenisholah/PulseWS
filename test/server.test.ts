import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import type { PulseWsConfig } from "../src/config.js";
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
const clients: PusherClient[] = [];
const rawSockets: WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }

  for (const socket of rawSockets.splice(0)) {
    socket.close();
  }

  for (const server of servers.splice(0)) {
    server.close();
  }
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

function createClient(key: string, port: number): PusherClient {
  const client = new Pusher(key, {
    cluster: "mt1",
    wsHost: "127.0.0.1",
    wsPort: port,
    forceTLS: false,
    enabledTransports: ["ws"],
    disableStats: true,
  });
  clients.push(client);
  return client;
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
