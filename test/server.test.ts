import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import type { PulseWsConfig } from "../src/config.js";
import { APP_NOT_FOUND_CLOSE_CODE, startServer, type PulseWsServer } from "../src/server.js";

const require = createRequire(import.meta.url);
const Pusher = (require("pusher-js") as { Pusher: PusherConstructor }).Pusher;

type PusherConstructor = new (key: string, options: Record<string, unknown>) => PusherClient;

type PusherClient = {
  connection: {
    socket_id: string;
    bind: (event: string, callback: (payload: never) => void) => void;
  };
  disconnect: () => void;
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

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.disconnect();
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

async function startTestServer(): Promise<PulseWsServer> {
  const server = await startServer(testConfig);
  servers.push(server);
  return server;
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
