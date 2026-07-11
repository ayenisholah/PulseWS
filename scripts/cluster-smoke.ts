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
  members: { count: number };
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
  if (firstChannel.members.count !== 2 || secondChannel.members.count !== 2) {
    throw new Error("Cluster presence roster did not reach two unique members");
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

  console.log(
    JSON.stringify({
      ok: true,
      url: baseUrl.origin,
      clients: [
        { socketId: firstConnection, nodeId: firstNode },
        { socketId: secondConnection, nodeId: secondNode },
      ],
      presenceCount: secondChannel.members.count,
      restPublishStatus: response.status,
      demoAuthorization: "passed through nginx",
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
  };
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
