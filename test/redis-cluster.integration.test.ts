import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import PusherServer from "pusher";
import { afterEach, describe, expect, test } from "vitest";

import type { PulseWsConfig } from "../src/config.js";
import { startServer, type PulseWsServer } from "../src/server.js";

const redisUrl = process.env.PULSEWS_TEST_REDIS_URL;
const servers: PulseWsServer[] = [];
const sockets: WebSocket[] = [];
const redisClients: Redis[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(redisClients.splice(0).map((client) => client.quit()));
});

describe.skipIf(!redisUrl)("Redis cluster event fan-out", () => {
  test(
    "delivers Redis echoes across two nodes and preserves socket exclusion",
    async () => {
      const clusterId = randomUUID();
      const appId = `integration-${clusterId}`;
      const appKey = `key-${clusterId}`;
      const appSecret = `secret-${clusterId}`;
      const config: PulseWsConfig = {
        port: 0,
        redisUrl: requiredRedisUrl(),
        apps: [
          {
            id: appId,
            key: appKey,
            secret: appSecret,
            maxConnections: 100,
            maxClientEventsPerSecond: 10,
            maxRestPublishesPerSecond: 100,
          },
        ],
      };
      const [nodeA, nodeB] = await Promise.all([
        startServer(config),
        startServer(config),
      ]);
      servers.push(nodeA, nodeB);

      const [clientA, clientB] = await Promise.all([
        connectRawClient(nodeA.port, appKey),
        connectRawClient(nodeB.port, appKey),
      ]);
      expect(clientA.nodeId).toBe(nodeA.nodeId);
      expect(clientB.nodeId).toBe(nodeB.nodeId);
      expect(clientA.nodeId).not.toBe(clientB.nodeId);

      await Promise.all([
        subscribe(clientA.socket, "public-cluster"),
        subscribe(clientB.socket, "public-cluster"),
      ]);

      const sdk = createServerSdk(
        nodeA.port,
        appId,
        appKey,
        appSecret,
      );
      const deliveredOnA = waitForEvent(clientA.socket, "cluster.event");
      const deliveredOnB = waitForEvent(clientB.socket, "cluster.event");
      const response = await sdk.trigger(
        "public-cluster",
        "cluster.event",
        { from: "node-a" },
      );
      expect(response.status).toBe(200);
      await expect(deliveredOnA).resolves.toMatchObject({
        channel: "public-cluster",
        data: JSON.stringify({ from: "node-a" }),
      });
      await expect(deliveredOnB).resolves.toMatchObject({
        channel: "public-cluster",
        data: JSON.stringify({ from: "node-a" }),
      });

      const deliveredToPeer = waitForEvent(
        clientA.socket,
        "cluster.excluded",
      );
      const excluded = waitForOptionalEvent(
        clientB.socket,
        "cluster.excluded",
        250,
      );
      const excludedResponse = await sdk.trigger(
        "public-cluster",
        "cluster.excluded",
        { excluded: clientB.socketId },
        { socket_id: clientB.socketId },
      );
      expect(excludedResponse.status).toBe(200);
      await expect(deliveredToPeer).resolves.toBeDefined();
      await expect(excluded).resolves.toBeUndefined();

      const redis = new Redis(requiredRedisUrl());
      redisClients.push(redis);
      await redis.publish(`pulsews:events:${appId}`, "malformed-envelope");
      await wait(50);

      const afterMalformed = waitForEvent(
        clientB.socket,
        "cluster.after-malformed",
      );
      const healthyResponse = await sdk.trigger(
        "public-cluster",
        "cluster.after-malformed",
        { healthy: true },
      );
      expect(healthyResponse.status).toBe(200);
      await expect(afterMalformed).resolves.toMatchObject({
        data: JSON.stringify({ healthy: true }),
      });
    },
    15_000,
  );

  test(
    "enforces a cluster-wide connection cap and releases clean disconnects",
    async () => {
      const clusterId = randomUUID();
      const appId = `cap-${clusterId}`;
      const appKey = `key-${clusterId}`;
      const config: PulseWsConfig = {
        port: 0,
        redisUrl: requiredRedisUrl(),
        apps: [
          {
            id: appId,
            key: appKey,
            secret: `secret-${clusterId}`,
            maxConnections: 1,
            maxClientEventsPerSecond: 10,
            maxRestPublishesPerSecond: 100,
          },
        ],
      };
      const [nodeA, nodeB] = await Promise.all([
        startServer(config),
        startServer(config),
      ]);
      servers.push(nodeA, nodeB);
      const redis = new Redis(requiredRedisUrl());
      redisClients.push(redis);

      const first = await connectRawClient(nodeA.port, appKey);
      await expect(
        waitForRedisConnectionCount(redis, appId, "1"),
      ).resolves.toBeUndefined();

      const refusedSocket = openRawSocket(nodeB.port, appKey);
      const refused = await waitForEvent(refusedSocket, "pusher:error");
      expect(JSON.parse(String(refused.data))).toMatchObject({ code: 4100 });

      const firstClosed = waitForClose(first.socket);
      first.socket.close();
      await firstClosed;
      await expect(
        waitForRedisConnectionCount(redis, appId, null),
      ).resolves.toBeUndefined();

      await expect(connectRawClient(nodeB.port, appKey)).resolves.toBeDefined();
    },
    15_000,
  );
});

function requiredRedisUrl(): string {
  if (!redisUrl) {
    throw new Error("PULSEWS_TEST_REDIS_URL is required for Redis tests");
  }
  return redisUrl;
}

function createServerSdk(
  port: number,
  appId: string,
  key: string,
  secret: string,
): PusherServer {
  return new PusherServer({
    appId,
    key,
    secret,
    host: "127.0.0.1",
    port: String(port),
    useTLS: false,
  });
}

async function connectRawClient(
  port: number,
  appKey: string,
): Promise<{ socket: WebSocket; socketId: string; nodeId: string }> {
  const socket = openRawSocket(port, appKey);

  return new Promise((resolve, reject) => {
    let socketId: string | undefined;
    let nodeId: string | undefined;
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Redis test connection")),
      3_000,
    );
    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(String(message.data)) as {
        event?: string;
        data?: string;
      };
      if (parsed.event === "pusher:connection_established") {
        socketId = (JSON.parse(String(parsed.data)) as { socket_id: string })
          .socket_id;
      }
      if (parsed.event === "pulsews:node") {
        nodeId = (JSON.parse(String(parsed.data)) as { node_id: string }).node_id;
      }
      if (socketId && nodeId) {
        clearTimeout(timeout);
        resolve({ socket, socketId, nodeId });
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Redis test WebSocket connection failed"));
    });
  });
}

function openRawSocket(port: number, appKey: string): WebSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/app/${appKey}?protocol=7&client=js&version=8.5.0`,
  );
  sockets.push(socket);
  return socket;
}

async function subscribe(socket: WebSocket, channel: string): Promise<void> {
  const subscribed = waitForEvent(
    socket,
    "pusher_internal:subscription_succeeded",
  );
  socket.send(
    JSON.stringify({ event: "pusher:subscribe", data: { channel } }),
  );
  await subscribed;
}

function waitForEvent(
  socket: WebSocket,
  expectedEvent: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedEvent}`)),
      3_000,
    );
    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (parsed.event === expectedEvent) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForOptionalEvent(
  socket: WebSocket,
  expectedEvent: string,
  timeoutMilliseconds: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (parsed.event === expectedEvent) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function wait(timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMilliseconds));
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Redis test socket close")),
      3_000,
    );
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForRedisConnectionCount(
  redis: Redis,
  appId: string,
  expected: string | null,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await redis.get(`pulsews:app:${appId}:connections`)) === expected) {
      return;
    }
    await wait(25);
  }
  throw new Error(`Timed out waiting for Redis connection count ${expected}`);
}
