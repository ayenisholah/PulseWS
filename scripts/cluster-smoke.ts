import { createRequire } from "node:module";

import PusherServer from "pusher";

const require = createRequire(import.meta.url);
const Pusher = (require("pusher-js") as { Pusher: PusherConstructor }).Pusher;

type PusherConstructor = new (
  key: string,
  options: Record<string, unknown>,
) => PusherClient;

type PusherClient = {
  connection: {
    socket_id: string;
    bind: (event: string, callback: (payload: unknown) => void) => void;
  };
  bind: (event: string, callback: (payload: NodePayload) => void) => void;
  subscribe: (channel: string) => PusherChannel;
  disconnect: () => void;
};

type PusherChannel = {
  bind: (event: string, callback: (payload: unknown) => void) => void;
  members: {
    count: number;
    get: (userId: string) => { id: string } | null;
  };
};

type NodePayload = { node_id: string };

const baseUrl = new URL(
  process.env.PULSEWS_SMOKE_URL ?? "http://127.0.0.1:8080",
);
const appId = process.env.PULSEWS_APP_ID ?? "demo-app";
const appKey = process.env.PULSEWS_APP_KEY ?? "demo-key";
const appSecret =
  process.env.PULSEWS_APP_SECRET ?? "replace-with-a-long-random-secret";
const channelName = process.env.PULSEWS_PRESENCE_CHANNEL ?? "presence-demo";
const clients: PusherClient[] = [];
const failoverTimeoutSeconds = Number.parseInt(
  process.env.PULSEWS_FAILOVER_TIMEOUT_SECONDS ?? "0",
  10,
);

try {
  const first = createClient("smoke-user-a", "Smoke A");
  clients.push(first.client);
  const firstConnection = await first.connected;
  const firstNode = await first.node;
  const firstChannel = first.client.subscribe(channelName);
  await waitForChannelEvent(firstChannel, "pusher:subscription_succeeded");

  const second = createClient("smoke-user-b", "Smoke B");
  clients.push(second.client);
  const secondConnection = await second.connected;
  const secondNode = await second.node;
  if (firstNode === secondNode) {
    throw new Error(`Both smoke clients reached ${firstNode}; expected two nodes`);
  }

  const memberAdded = waitForChannelEvent(
    firstChannel,
    "pusher:member_added",
  );
  const secondChannel = second.client.subscribe(channelName);
  await waitForChannelEvent(secondChannel, "pusher:subscription_succeeded");
  await memberAdded;
  const expectedUsers = ["smoke-user-a", "smoke-user-b"];
  if (
    expectedUsers.some(
      (userId) =>
        firstChannel.members.get(userId) === null ||
        secondChannel.members.get(userId) === null,
    )
  ) {
    throw new Error(
      `Cluster presence rosters did not contain both smoke members (first=${firstChannel.members.count}, second=${secondChannel.members.count}, channel=${channelName})`,
    );
  }

  const eventOnFirst = waitForChannelEvent(firstChannel, "smoke.event");
  const eventOnSecond = waitForChannelEvent(secondChannel, "smoke.event");
  const sdk = new PusherServer({
    appId,
    key: appKey,
    secret: appSecret,
    host: baseUrl.hostname,
    port: effectivePort(baseUrl),
    useTLS: baseUrl.protocol === "https:",
  });
  const response = await sdk.trigger(channelName, "smoke.event", {
    through: "nginx",
  });
  if (response.status !== 200) {
    throw new Error(`REST publish returned HTTP ${response.status}`);
  }
  await Promise.all([eventOnFirst, eventOnSecond]);

  if (failoverTimeoutSeconds > 0) {
    await waitForCondition(
      () => first.connectionCount + second.connectionCount >= 3,
      failoverTimeoutSeconds * 1_000,
      "Timed out waiting for a client to reconnect during failover",
    );
    await waitForCondition(
      () =>
        ["smoke-user-a", "smoke-user-b"].every(
          (userId) =>
            firstChannel.members.get(userId) !== null &&
            secondChannel.members.get(userId) !== null,
        ),
      10_000,
      "Presence did not converge after failover",
    );
    const failoverOnFirst = waitForChannelEvent(firstChannel, "smoke.failover");
    const failoverOnSecond = waitForChannelEvent(secondChannel, "smoke.failover");
    const failoverResponse = await sdk.trigger(channelName, "smoke.failover", {
      afterReconnect: true,
    });
    if (failoverResponse.status !== 200) {
      throw new Error(`Post-failover REST publish returned HTTP ${failoverResponse.status}`);
    }
    await Promise.all([failoverOnFirst, failoverOnSecond]);
  }

  console.log(
    JSON.stringify({
      ok: true,
      url: baseUrl.origin,
      clients: [
        { socketId: firstConnection, nodeId: firstNode },
        { socketId: secondConnection, nodeId: secondNode },
      ],
      presenceCount: secondChannel.members.count,
      presenceChannel: channelName,
      restPublishStatus: response.status,
      demoAuthorization: "passed through nginx",
      connectionCount: first.connectionCount + second.connectionCount,
      failover: failoverTimeoutSeconds > 0 ? "reconnected and delivered" : "not requested",
    }),
  );
} finally {
  for (const client of clients) {
    client.disconnect();
  }
}

function createClient(
  userId: string,
  name: string,
): {
  client: PusherClient;
  connected: Promise<string>;
  node: Promise<string>;
  readonly connectionCount: number;
} {
  const secure = baseUrl.protocol === "https:";
  const client = new Pusher(appKey, {
    cluster: "mt1",
    wsHost: baseUrl.hostname,
    wsPort: Number(effectivePort(baseUrl)),
    wssPort: Number(effectivePort(baseUrl)),
    forceTLS: secure,
    enabledTransports: ["ws", "wss"],
    disableStats: true,
    channelAuthorization: {
      customHandler: (
        params: { socketId: string; channelName: string },
        callback: (
          error: Error | null,
          authorization: { auth: string; channel_data: string } | null,
        ) => void,
      ) => {
        void fetch(new URL("/demo/auth", baseUrl), {
          method: "POST",
          body: new URLSearchParams({
            socket_id: params.socketId,
            channel_name: params.channelName,
            user_id: userId,
            user_info: JSON.stringify({ name }),
          }),
        })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`Demo authorization returned ${response.status}`);
            }
            return (await response.json()) as {
              auth: string;
              channel_data: string;
            };
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

  let connectionCount = 0;
  client.connection.bind("connected", () => {
    connectionCount += 1;
  });

  return {
    client,
    connected: new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for smoke connection")),
        10_000,
      );
      client.connection.bind("connected", () => {
        clearTimeout(timeout);
        resolve(client.connection.socket_id);
      });
      client.connection.bind("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    }),
    node: new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for node identity")),
        10_000,
      );
      client.bind("pulsews:node", (payload) => {
        clearTimeout(timeout);
        resolve(payload.node_id);
      });
    }),
    get connectionCount() {
      return connectionCount;
    },
  };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function waitForChannelEvent(
  channel: PusherChannel,
  event: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      10_000,
    );
    channel.bind(event, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}
