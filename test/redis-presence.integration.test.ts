import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { createPresenceChannelAuth } from "../src/auth.js";
import type { PulseWsConfig } from "../src/config.js";
import type { PresenceRoster } from "../src/presence.js";
import { startServer, type PulseWsServer } from "../src/server.js";

const redisUrl = process.env.PULSEWS_TEST_REDIS_URL;
const channel = "presence-cluster";
const servers: PulseWsServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe.skipIf(!redisUrl)("Redis cluster presence", () => {
  test(
    "keeps cross-node rosters and duplicate-user lifecycle atomic",
    async () => {
      const clusterId = randomUUID();
      const appId = `presence-${clusterId}`;
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
          },
        ],
      };
      const [nodeA, nodeB] = await Promise.all([
        startServer(config),
        startServer(config),
      ]);
      servers.push(nodeA, nodeB);

      const adaA = await connect(nodeA.port, appKey);
      const adaRoster = await subscribePresence(
        adaA,
        appKey,
        appSecret,
        "user-ada",
        { name: "Ada" },
      );
      expect(adaRoster.presence).toEqual({
        ids: ["user-ada"],
        hash: { "user-ada": { name: "Ada" } },
        count: 1,
      });

      const closingDuringJoin = await connect(nodeB.port, appKey);
      sendPresenceSubscription(
        closingDuringJoin,
        appKey,
        appSecret,
        "user-closing",
        { name: "Closing" },
      );
      const closedDuringJoin = waitForClose(closingDuringJoin.socket);
      closingDuringJoin.socket.close();
      await closedDuringJoin;
      await wait(200);

      const graceB = await connect(nodeB.port, appKey);
      const graceAdded = waitForEvent(
        adaA.socket,
        "pusher_internal:member_added",
      );
      const graceRoster = await subscribePresence(
        graceB,
        appKey,
        appSecret,
        "user-grace",
        { name: "Grace" },
      );
      expect(graceRoster.presence.count).toBe(2);
      expect(new Set(graceRoster.presence.ids)).toEqual(
        new Set(["user-ada", "user-grace"]),
      );
      await expect(graceAdded).resolves.toMatchObject({
        data: JSON.stringify({
          user_id: "user-grace",
          user_info: { name: "Grace" },
        }),
      });

      const adaDuplicateB = await connect(nodeB.port, appKey);
      const unexpectedDuplicateAdd = waitForOptionalMemberEvent(
        graceB.socket,
        "pusher_internal:member_added",
        "user-ada",
        250,
      );
      const duplicateRoster = await subscribePresence(
        adaDuplicateB,
        appKey,
        appSecret,
        "user-ada",
        { name: "Ada" },
      );
      expect(duplicateRoster.presence.count).toBe(2);
      await expect(unexpectedDuplicateAdd).resolves.toBeUndefined();

      const clientEvent = waitForEvent(graceB.socket, "client-status");
      const senderEcho = waitForOptionalEvent(
        adaA.socket,
        "client-status",
        250,
      );
      adaA.socket.send(
        JSON.stringify({
          event: "client-status",
          channel,
          data: { online: true },
        }),
      );
      await expect(clientEvent).resolves.toMatchObject({
        data: JSON.stringify({ online: true }),
        user_id: "user-ada",
      });
      await expect(senderEcho).resolves.toBeUndefined();

      const unexpectedDuplicateRemove = waitForOptionalMemberEvent(
        graceB.socket,
        "pusher_internal:member_removed",
        "user-ada",
        250,
      );
      unsubscribe(adaDuplicateB.socket);
      await expect(unexpectedDuplicateRemove).resolves.toBeUndefined();

      const adaRemoved = waitForMemberEvent(
        graceB.socket,
        "pusher_internal:member_removed",
        "user-ada",
      );
      unsubscribe(adaA.socket);
      await expect(adaRemoved).resolves.toBeDefined();

      const linusA = await connect(nodeA.port, appKey);
      const linusAdded = waitForMemberEvent(
        graceB.socket,
        "pusher_internal:member_added",
        "user-linus",
      );
      await subscribePresence(
        linusA,
        appKey,
        appSecret,
        "user-linus",
        { name: "Linus" },
      );
      await linusAdded;

      const linusRemoved = waitForMemberEvent(
        graceB.socket,
        "pusher_internal:member_removed",
        "user-linus",
      );
      const linusClosed = waitForClose(linusA.socket);
      linusA.socket.close();
      await linusClosed;
      await expect(linusRemoved).resolves.toBeDefined();

      unsubscribe(graceB.socket);
      await wait(50);
    },
    20_000,
  );
});

type ConnectedClient = {
  socket: WebSocket;
  socketId: string;
};

async function connect(port: number, appKey: string): Promise<ConnectedClient> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/app/${appKey}?protocol=7&client=js&version=8.5.0`,
  );
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for presence connection")),
      3_000,
    );
    socket.addEventListener("message", (message) => {
      const parsed = parseMessage(message);
      if (parsed.event === "pusher:connection_established") {
        clearTimeout(timeout);
        resolve({
          socket,
          socketId: (JSON.parse(String(parsed.data)) as { socket_id: string })
            .socket_id,
        });
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Presence WebSocket connection failed"));
    });
  });
}

async function subscribePresence(
  client: ConnectedClient,
  appKey: string,
  appSecret: string,
  userId: string,
  userInfo: Record<string, unknown>,
): Promise<PresenceRoster> {
  const subscribed = waitForEvent(
    client.socket,
    "pusher_internal:subscription_succeeded",
  );
  sendPresenceSubscription(
    client,
    appKey,
    appSecret,
    userId,
    userInfo,
  );
  const message = await subscribed;
  return JSON.parse(String(message.data)) as PresenceRoster;
}

function sendPresenceSubscription(
  client: ConnectedClient,
  appKey: string,
  appSecret: string,
  userId: string,
  userInfo: Record<string, unknown>,
): void {
  const channelData = JSON.stringify({
    user_id: userId,
    user_info: userInfo,
  });
  client.socket.send(
    JSON.stringify({
      event: "pusher:subscribe",
      data: {
        channel,
        channel_data: channelData,
        auth: createPresenceChannelAuth(
          { key: appKey, secret: appSecret },
          client.socketId,
          channel,
          channelData,
        ),
      },
    }),
  );
}

function unsubscribe(socket: WebSocket): void {
  socket.send(
    JSON.stringify({ event: "pusher:unsubscribe", data: { channel } }),
  );
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
      const parsed = parseMessage(message);
      if (parsed.event === expectedEvent) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForMemberEvent(
  socket: WebSocket,
  expectedEvent: string,
  expectedUserId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedEvent}`)),
      3_000,
    );
    socket.addEventListener("message", (message) => {
      const parsed = parseMessage(message);
      if (
        parsed.event === expectedEvent &&
        (JSON.parse(String(parsed.data)) as { user_id?: string }).user_id ===
          expectedUserId
      ) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForOptionalMemberEvent(
  socket: WebSocket,
  expectedEvent: string,
  expectedUserId: string,
  timeoutMilliseconds: number,
): Promise<Record<string, unknown> | undefined> {
  return optionalEvent(socket, timeoutMilliseconds, (parsed) =>
    parsed.event === expectedEvent
      ? (JSON.parse(String(parsed.data)) as { user_id?: string }).user_id ===
        expectedUserId
      : false,
  );
}

function waitForOptionalEvent(
  socket: WebSocket,
  expectedEvent: string,
  timeoutMilliseconds: number,
): Promise<Record<string, unknown> | undefined> {
  return optionalEvent(
    socket,
    timeoutMilliseconds,
    (parsed) => parsed.event === expectedEvent,
  );
}

function optionalEvent(
  socket: WebSocket,
  timeoutMilliseconds: number,
  matches: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    socket.addEventListener("message", (message) => {
      const parsed = parseMessage(message);
      if (matches(parsed)) {
        clearTimeout(timeout);
        resolve(parsed);
      }
    });
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket close")),
      3_000,
    );
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function parseMessage(message: MessageEvent): Record<string, unknown> {
  return JSON.parse(String(message.data)) as Record<string, unknown>;
}

function requiredRedisUrl(): string {
  if (!redisUrl) {
    throw new Error("PULSEWS_TEST_REDIS_URL is required for Redis tests");
  }
  return redisUrl;
}

function wait(timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMilliseconds));
}
