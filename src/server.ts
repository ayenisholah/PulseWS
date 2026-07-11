import { randomUUID } from "node:crypto";

import pino, { type Logger } from "pino";
import uWS, { type us_listen_socket } from "uWebSockets.js";

import {
  LocalEventAdapter,
  type LocalEventSocket,
} from "./adapter/local.js";
import { RedisEventAdapter } from "./adapter/redis.js";
import type { EventAdapter } from "./adapter/types.js";
import {
  verifyPrivateChannelAuth,
  verifyPresenceChannelAuth,
  verifyRestRequest,
} from "./auth.js";
import {
  classifyChannelName,
  isValidChannelName,
  topicFor,
  validateSubscribableChannelName,
} from "./channels.js";
import {
  type ClusterTimingOptions,
  type ConnectionCoordinator,
  LocalConnectionCoordinator,
  RedisClusterCoordinator,
} from "./cluster.js";
import type { AppConfig, PulseWsConfig } from "./config.js";
import {
  authorizeDemoPresence,
  loadDemoAssets,
  type DemoAssets,
} from "./demo.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
  APP_NOT_FOUND_MESSAGE,
  CLIENT_EVENT_RATE_LIMIT_CODE,
  DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
  type ClientMessage,
  connectionEstablishedMessage,
  createSocketId,
  decodeClientMessage,
  encodePusherData,
  encodePusherMessage,
  errorMessage,
  nodeIdentifiedMessage,
  pongMessage,
  subscriptionSucceededMessage,
} from "./protocol.js";
import {
  LimitedBodyBuffer,
  MAX_INGRESS_BYTES,
  parsePublishRequest,
} from "./publish.js";
import {
  LocalPresenceRegistry,
  parsePresenceChannelData,
  type PresenceMember,
  type PresenceRegistry,
} from "./presence.js";
import { PulseWsMetrics } from "./metrics.js";
import { TokenBucket } from "./ratelimit.js";
import { RedisPresenceRegistry } from "./redis-presence.js";

const DEFAULT_ACTIVITY_GRACE_SECONDS = 30;
const DEFAULT_REAPER_INTERVAL_MILLISECONDS = 1_000;
export const CONNECTION_LIMIT_ERROR_CODE = 4100;

type SocketData =
  | {
      accepted: true;
      app: AppConfig;
      socketId: string;
      subscriptions: Set<string>;
      presenceMemberships: Map<string, PresenceMember>;
      clientEventLimiter: TokenBucket;
      subscriptionOperations: Promise<void>;
      connectionReserved: boolean;
      lastActivityAt: number;
      closed: boolean;
    }
  | {
      accepted: false;
      closed: boolean;
    };

export type PulseWsServer = {
  port: number;
  nodeId: string;
  publish: (
    appId: string,
    channel: string,
    event: string,
    data: unknown,
  ) => Promise<boolean>;
  close: () => Promise<void>;
};

export type ServerTimingOptions = ClusterTimingOptions & {
  activityTimeoutSeconds?: number;
  activityGraceSeconds?: number;
  reaperIntervalMilliseconds?: number;
};

export async function startServer(
  config: PulseWsConfig,
  timing: ServerTimingOptions = {},
): Promise<PulseWsServer> {
  const demoAssets = config.demo ? await loadDemoAssets() : undefined;
  const clusterSize = readClusterSize(process.env.PULSEWS_CLUSTER_SIZE);
  const appsByKey = new Map(config.apps.map((app) => [app.key, app]));
  const appsById = new Map(
    config.apps.map((configuredApp) => [configuredApp.id, configuredApp]),
  );
  const app = uWS.App();
  const acceptedSockets = new Set<uWS.WebSocket<SocketData>>();
  const acceptedSocketsById = new Map<string, LocalEventSocket>();
  const nodeId = resolveNodeId(process.env.PULSEWS_NODE_ID);
  const logger = pino();
  const metrics = new PulseWsMetrics(config.apps.map(({ id }) => id));
  const localAdapter = new LocalEventAdapter(
    app,
    acceptedSocketsById,
    nodeId,
    metrics,
  );
  const redisAdapter = config.redisUrl
    ? new RedisEventAdapter(
        config.redisUrl,
        config.apps.map((configuredApp) => configuredApp.id),
        nodeId,
        localAdapter,
        {
          warn: (details, message) => logger.warn(details, message),
          error: (details, message) => logger.error(details, message),
          drop: (reason) => metrics.drop(reason),
        },
      )
    : undefined;
  const adapter: EventAdapter = redisAdapter ?? localAdapter;
  const redisPresence = redisAdapter
    ? new RedisPresenceRegistry(redisAdapter, nodeId)
    : undefined;
  const presence: PresenceRegistry =
    redisPresence ?? new LocalPresenceRegistry();
  const connections: ConnectionCoordinator =
    redisAdapter && redisPresence
      ? new RedisClusterCoordinator(
          redisAdapter,
          redisPresence,
          adapter,
          nodeId,
          {
            warn: (details, message) => logger.warn(details, message),
            error: (details, message) => logger.error(details, message),
            drop: (reason) => metrics.drop(reason),
          },
          timing,
        )
      : new LocalConnectionCoordinator();
  await adapter.initialize();
  try {
    await connections.initialize();
  } catch (error) {
    await adapter.close();
    throw error;
  }
  const restPublishLimiters = new Map(
    config.apps.map((configuredApp) => [
      configuredApp.id,
      new TokenBucket(
        Math.max(
          1,
          Math.floor(
            configuredApp.maxRestPublishesPerSecond / clusterSize,
          ),
        ),
      ),
    ]),
  );
  const activityTimeoutSeconds =
    timing.activityTimeoutSeconds ?? DEFAULT_ACTIVITY_TIMEOUT_SECONDS;
  const activityGraceSeconds =
    timing.activityGraceSeconds ?? DEFAULT_ACTIVITY_GRACE_SECONDS;
  const reaperIntervalMilliseconds =
    timing.reaperIntervalMilliseconds ??
    DEFAULT_REAPER_INTERVAL_MILLISECONDS;

  app.ws<SocketData>("/app/:key", {
    maxPayloadLength: MAX_INGRESS_BYTES,
    upgrade: (res, req, context) => {
      const appKey = req.getParameter(0) ?? "";
      const configuredApp = appsByKey.get(appKey);

      res.upgrade(
        configuredApp
          ? {
              accepted: true,
              app: configuredApp,
              socketId: createSocketId(),
              subscriptions: new Set<string>(),
              presenceMemberships: new Map<string, PresenceMember>(),
              clientEventLimiter: new TokenBucket(
                configuredApp.maxClientEventsPerSecond,
              ),
              subscriptionOperations: Promise.resolve(),
              connectionReserved: false,
              lastActivityAt: Date.now(),
              closed: false,
            }
          : {
              accepted: false,
              closed: false,
            },
        req.getHeader("sec-websocket-key"),
        req.getHeader("sec-websocket-protocol"),
        req.getHeader("sec-websocket-extensions"),
        context,
      );
    },
    open: (ws) => {
      const data = ws.getUserData();
      if (!data.accepted) {
        ws.send(
          encodePusherMessage(
            errorMessage(APP_NOT_FOUND_CLOSE_CODE, APP_NOT_FOUND_MESSAGE),
          ),
        );
        const socketData = data;
        setTimeout(() => {
          if (!socketData.closed) {
            ws.close();
          }
        }, 10);
        return;
      }

      void connections
        .reserveConnection(
          data.app.id,
          data.socketId,
          data.app.maxConnections,
        )
        .then(async (reserved) => {
          if (data.closed) {
            if (reserved) {
              await connections.releaseConnection(data.app.id, data.socketId);
            }
            return;
          }
          if (!reserved) {
            sendError(
              ws,
              CONNECTION_LIMIT_ERROR_CODE,
              "Application connection limit exceeded",
            );
            setTimeout(() => {
              if (!data.closed) {
                ws.close();
              }
            }, 10);
            return;
          }

          data.connectionReserved = true;
          metrics.connectionOpened(data.app.id);
          data.lastActivityAt = Date.now();
          acceptedSockets.add(ws);
          acceptedSocketsById.set(
            data.socketId,
            ws as uWS.WebSocket<Extract<SocketData, { accepted: true }>>,
          );
          ws.send(
            encodePusherMessage(
              connectionEstablishedMessage(
                data.socketId,
                activityTimeoutSeconds,
              ),
            ),
          );
          ws.send(encodePusherMessage(nodeIdentifiedMessage(nodeId)));
        })
        .catch((error: unknown) => {
          metrics.drop("connection_reservation_failure");
          logger.error(
            { error: formatError(error), appId: data.app.id },
            "Connection reservation failed",
          );
          if (!data.closed) {
            sendError(ws, 4000, "Connection reservation failed");
            ws.close();
          }
        });
    },
    message: (ws, message) => {
      const data = ws.getUserData();
      if (!data.accepted) {
        return;
      }
      metrics.messageIn(data.app.id);
      data.lastActivityAt = Date.now();

      let clientMessage;
      try {
        clientMessage = decodeClientMessage(Buffer.from(message).toString("utf8"));
      } catch (error) {
        sendError(ws, 4000, formatError(error));
        return;
      }

      if (clientMessage.event === "pusher:ping") {
        ws.send(encodePusherMessage(pongMessage()));
        return;
      }

      if (clientMessage.event === "pusher:subscribe") {
        enqueueSubscriptionOperation(
          ws,
          () =>
            handleSubscribe(
              ws,
              clientMessage.data,
              adapter,
              presence,
              metrics,
            ),
          logger,
        );
        return;
      }

      if (clientMessage.event === "pusher:unsubscribe") {
        enqueueSubscriptionOperation(
          ws,
          () =>
            handleUnsubscribe(
              ws,
              clientMessage.data,
              adapter,
              presence,
              metrics,
            ),
          logger,
        );
        return;
      }

      if (clientMessage.event.startsWith("client-")) {
        handleClientEvent(ws, clientMessage, adapter, metrics);
      }
    },
    close: (ws) => {
      const data = ws.getUserData();
      data.closed = true;
      if (data.accepted) {
        acceptedSockets.delete(ws);
        if (acceptedSocketsById.get(data.socketId) === ws) {
          acceptedSocketsById.delete(data.socketId);
        }
        for (const channel of data.subscriptions) {
          metrics.subscriptionRemoved(
            data.app.id,
            classifyChannelName(channel),
          );
        }
        data.subscriptions.clear();
        if (data.connectionReserved) {
          metrics.connectionClosed(data.app.id);
        }
        void data.subscriptionOperations
          .then(async () => {
            for (const channel of data.presenceMemberships.keys()) {
              await leavePresenceChannel(data, channel, adapter, presence);
            }
            data.presenceMemberships.clear();
            if (data.connectionReserved) {
              await connections.releaseConnection(data.app.id, data.socketId);
              data.connectionReserved = false;
            }
          })
          .catch((error: unknown) => {
            metrics.drop("cluster_cleanup_failure");
            logger.error(
              { error: formatError(error), socketId: data.socketId },
              "Presence disconnect cleanup failed",
            );
          });
      }
    },
  });

  if (config.demo && demoAssets) {
    const demoApp = appsByKey.get(config.demo.appKey);
    if (!demoApp) {
      throw new Error("Demo app is not configured");
    }
    registerDemoRoutes(app, demoAssets, demoApp, config.demo.channel);
  }

  app.get("/health", (res) => {
    res
      .writeHeader("content-type", "application/json")
      .writeHeader("cache-control", "no-store")
      .end(JSON.stringify({ status: "ok", nodeId }));
  });

  app.get("/metrics", (res) => {
    let aborted = false;
    res.onAborted(() => {
      aborted = true;
    });
    void metrics.exposition().then(
      (body) => {
        if (!aborted) {
          res.cork(() => {
            res
              .writeHeader("content-type", metrics.contentType())
              .writeHeader("cache-control", "no-store")
              .end(body);
          });
        }
      },
      (error: unknown) => {
        logger.error({ error: formatError(error) }, "Metric exposition failed");
        if (!aborted) {
          res.cork(() => res.writeStatus("500 Internal Server Error").end());
        }
      },
    );
  });

  app.post("/apps/:appId/events", (res, req) => {
    const configuredApp = appsById.get(req.getParameter(0) ?? "");
    const path = req.getUrl();
    const rawQuery = req.getQuery();
    const bodyBuffer = new LimitedBodyBuffer();
    let aborted = false;
    let completed = false;

    res.onAborted(() => {
      aborted = true;
    });

    res.onData((chunk, isLast) => {
      if (aborted || completed) {
        return;
      }

      if (!bodyBuffer.append(chunk)) {
        completed = true;
        res.cork(() => {
          res
            .writeStatus("413 Payload Too Large")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }

      if (!isLast) {
        return;
      }

      completed = true;
      const rawBody = bodyBuffer.toBuffer();
      const authorized =
        configuredApp !== undefined &&
        verifyRestRequest({
          app: configuredApp,
          method: "POST",
          path,
          rawQuery,
          rawBody,
        });

      if (aborted) {
        return;
      }

      if (!authorized || !configuredApp) {
        res.cork(() => {
          res
            .writeStatus("401 Unauthorized")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }

      let publishRequest;
      try {
        publishRequest = parsePublishRequest(rawBody);
      } catch {
        res.cork(() => {
          res
            .writeStatus("400 Bad Request")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }

      const publishLimiter = restPublishLimiters.get(configuredApp.id);
      if (!publishLimiter?.tryConsume()) {
        metrics.throttleRest(configuredApp.id);
        res.cork(() => {
          res
            .writeStatus("429 Too Many Requests")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }

      for (const _channel of publishRequest.channels) {
        metrics.messageIn(configuredApp.id);
      }

      void Promise.all(
        publishRequest.channels.map((channel) =>
          adapter.publish({
            appId: configuredApp.id,
            channel,
            event: publishRequest.name,
            data: publishRequest.data,
            ...(publishRequest.socketId === undefined
              ? {}
              : { excludeSocket: publishRequest.socketId }),
          }),
        ),
      ).then(
        () => {
          if (!aborted) {
            res.cork(() => {
              res
                .writeStatus("200 OK")
                .writeHeader("content-type", "application/json")
                .end("{}");
            });
          }
        },
        (error: unknown) => {
          logger.error(
            { error: formatError(error), appId: configuredApp.id },
            "REST event publish failed",
          );
          if (!aborted) {
            res.cork(() => {
              res
                .writeStatus("503 Service Unavailable")
                .writeHeader("content-type", "application/json")
                .end("{}");
            });
          }
        },
      );
    });
  });

  let listenSocket: us_listen_socket;
  try {
    listenSocket = await listen(app, config.port);
  } catch (error) {
    await connections.close();
    await adapter.close();
    throw error;
  }
  const boundPort = uWS.us_socket_local_port(listenSocket);
  const staleAfterMilliseconds =
    (activityTimeoutSeconds + activityGraceSeconds) * 1_000;
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const ws of acceptedSockets) {
      const data = ws.getUserData();
      if (
        data.accepted &&
        !data.closed &&
        now - data.lastActivityAt > staleAfterMilliseconds
      ) {
        ws.close();
      }
    }
  }, reaperIntervalMilliseconds);
  reaper.unref();

  let closePromise: Promise<void> | undefined;
  return {
    port: boundPort,
    nodeId,
    publish: (appId, channel, event, data) =>
      adapter.publish({
        appId,
        channel,
        event,
        data: encodePusherData(data),
      }),
    close: () => {
      closePromise ??= (async () => {
        clearInterval(reaper);
        uWS.us_listen_socket_close(listenSocket);
        await connections.close();
        await adapter.close();
      })();
      return closePromise;
    },
  };
}

function registerDemoRoutes(
  app: uWS.TemplatedApp,
  assets: DemoAssets,
  demoApp: AppConfig,
  channel: string,
): void {
  app.get("/", (res) => {
    sendStaticAsset(res, assets.html, "text/html; charset=utf-8");
  });
  app.get("/styles.css", (res) => {
    sendStaticAsset(res, assets.css, "text/css; charset=utf-8");
  });
  app.get("/demo.js", (res) => {
    sendStaticAsset(res, assets.javascript, "text/javascript; charset=utf-8");
  });
  app.get("/demo/config", (res) => {
    res
      .writeHeader("content-type", "application/json")
      .writeHeader("cache-control", "no-store")
      .end(JSON.stringify({ appKey: demoApp.key, channel }));
  });
  app.post("/demo/auth", (res) => {
    const body = new LimitedBodyBuffer();
    let aborted = false;
    let completed = false;
    res.onAborted(() => {
      aborted = true;
    });
    res.onData((chunk, isLast) => {
      if (aborted || completed) {
        return;
      }
      if (!body.append(chunk)) {
        completed = true;
        res.cork(() => {
          res
            .writeStatus("413 Payload Too Large")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }
      if (!isLast) {
        return;
      }

      completed = true;
      let authorization;
      try {
        authorization = authorizeDemoPresence(
          demoApp,
          channel,
          body.toBuffer(),
        );
      } catch {
        res.cork(() => {
          res
            .writeStatus("403 Forbidden")
            .writeHeader("content-type", "application/json")
            .end("{}");
        });
        return;
      }
      if (!aborted) {
        res.cork(() => {
          res
            .writeHeader("content-type", "application/json")
            .writeHeader("cache-control", "no-store")
            .end(JSON.stringify(authorization));
        });
      }
    });
  });
}

function sendStaticAsset(
  res: uWS.HttpResponse,
  body: Buffer,
  contentType: string,
): void {
  res
    .writeHeader("content-type", contentType)
    .writeHeader("cache-control", "no-store")
    .end(body);
}

function listen(app: uWS.TemplatedApp, port: number): Promise<us_listen_socket> {
  return new Promise((resolve, reject) => {
    app.listen(port, (listenSocket) => {
      if (!listenSocket) {
        reject(new Error(`Unable to listen on port ${port}`));
        return;
      }

      resolve(listenSocket);
    });
  });
}

async function handleSubscribe(
  ws: uWS.WebSocket<SocketData>,
  payload: unknown,
  adapter: EventAdapter,
  presence: PresenceRegistry,
  metrics: PulseWsMetrics,
): Promise<void> {
  const data = ws.getUserData();
  if (!data.accepted || data.closed) {
    return;
  }

  const subscription = readSubscriptionFromPayload(payload);
  const validation = validateSubscribableChannelName(subscription?.channel);

  if (!validation.ok) {
    sendError(ws, 4000, validation.reason);
    return;
  }

  if (
    validation.type === "private" &&
    !verifyPrivateChannelAuth(
      data.app,
      data.socketId,
      validation.channel,
      subscription?.auth,
    )
  ) {
    sendError(ws, 4000, "Invalid subscription authorization");
    return;
  }

  let presenceMember: PresenceMember | undefined;
  if (validation.type === "presence") {
    if (
      !verifyPresenceChannelAuth(
        data.app,
        data.socketId,
        validation.channel,
        subscription?.channelData,
        subscription?.auth,
      )
    ) {
      sendError(ws, 4000, "Invalid presence subscription authorization");
      return;
    }

    try {
      presenceMember = parsePresenceChannelData(subscription?.channelData);
    } catch (error) {
      sendError(ws, 4000, formatError(error));
      return;
    }

    const joined = await presence.join(
      data.app.id,
      validation.channel,
      data.socketId,
      presenceMember,
    );
    if (data.closed) {
      await presence.leave(data.app.id, validation.channel, data.socketId);
      return;
    }
    if (!joined.ok) {
      sendError(ws, 4000, joined.reason);
      return;
    }

    if (joined.memberAdded) {
      try {
        await adapter.publish({
          appId: data.app.id,
          channel: validation.channel,
          event: "pusher_internal:member_added",
          data: encodePusherData({
            user_id: presenceMember.userId,
            user_info: presenceMember.userInfo,
          }),
          excludeSocket: data.socketId,
        });
      } catch (error) {
        await presence.leave(data.app.id, validation.channel, data.socketId);
        throw error;
      }
      if (data.closed) {
        await leavePresenceChannel(data, validation.channel, adapter, presence);
        return;
      }
    } else if (data.closed) {
      await presence.leave(data.app.id, validation.channel, data.socketId);
      return;
    }

    const topic = topicFor(data.app.id, validation.channel);
    ws.subscribe(topic);
    if (!data.subscriptions.has(validation.channel)) {
      data.subscriptions.add(validation.channel);
      metrics.subscriptionAdded(data.app.id, validation.type);
    }
    data.presenceMemberships.set(validation.channel, presenceMember);
    ws.send(
      encodePusherMessage(
        subscriptionSucceededMessage(validation.channel, joined.roster),
      ),
    );
    return;
  }

  const topic = topicFor(data.app.id, validation.channel);
  ws.subscribe(topic);
  if (!data.subscriptions.has(validation.channel)) {
    data.subscriptions.add(validation.channel);
    metrics.subscriptionAdded(data.app.id, validation.type);
  }
  ws.send(
    encodePusherMessage(subscriptionSucceededMessage(validation.channel)),
  );
}

async function handleUnsubscribe(
  ws: uWS.WebSocket<SocketData>,
  payload: unknown,
  adapter: EventAdapter,
  presence: PresenceRegistry,
  metrics: PulseWsMetrics,
): Promise<void> {
  const data = ws.getUserData();
  if (!data.accepted || data.closed) {
    return;
  }

  const channel = readChannelFromPayload(payload);
  const validation = validateSubscribableChannelName(channel);

  if (!validation.ok) {
    sendError(ws, 4000, validation.reason);
    return;
  }

  ws.unsubscribe(topicFor(data.app.id, validation.channel));
  if (data.subscriptions.delete(validation.channel)) {
    metrics.subscriptionRemoved(data.app.id, validation.type);
  }
  if (validation.type === "presence") {
    await leavePresenceChannel(data, validation.channel, adapter, presence);
    data.presenceMemberships.delete(validation.channel);
  }
}

function handleClientEvent(
  ws: uWS.WebSocket<SocketData>,
  message: ClientMessage,
  adapter: EventAdapter,
  metrics: PulseWsMetrics,
): void {
  const data = ws.getUserData();
  if (!data.accepted) {
    return;
  }

  const channel = message.channel;
  const channelType = channel ? classifyChannelName(channel) : undefined;
  if (
    !isValidChannelName(channel) ||
    (channelType !== "private" && channelType !== "presence") ||
    !data.subscriptions.has(channel)
  ) {
    metrics.rejectClientEvent(data.app.id, "invalid_channel");
    sendError(
      ws,
      4000,
      "Client events require a subscribed private or presence channel",
    );
    return;
  }

  if (!data.clientEventLimiter.tryConsume()) {
    metrics.rejectClientEvent(data.app.id, "rate_limited");
    sendError(ws, CLIENT_EVENT_RATE_LIMIT_CODE, "Client event rate limit exceeded");
    return;
  }

  const presenceUserId =
    channelType === "presence"
      ? data.presenceMemberships.get(channel)?.userId
      : undefined;
  void adapter.publish({
    appId: data.app.id,
    channel,
    event: message.event,
    data: encodePusherData(message.data),
    excludeSocket: data.socketId,
    ...(presenceUserId === undefined ? {} : { userId: presenceUserId }),
  }).catch(() => undefined);
}

async function leavePresenceChannel(
  data: Extract<SocketData, { accepted: true }>,
  channel: string,
  adapter: EventAdapter,
  presence: PresenceRegistry,
): Promise<void> {
  const left = await presence.leave(data.app.id, channel, data.socketId);
  if (!left.memberRemoved || !left.member) {
    return;
  }

  await adapter.publish({
    appId: data.app.id,
    channel,
    event: "pusher_internal:member_removed",
    data: encodePusherData({ user_id: left.member.userId }),
  });
}

function enqueueSubscriptionOperation(
  ws: uWS.WebSocket<SocketData>,
  operation: () => Promise<void>,
  logger: Logger,
): void {
  const data = ws.getUserData();
  if (!data.accepted || data.closed) {
    return;
  }

  data.subscriptionOperations = data.subscriptionOperations
    .then(async () => {
      if (!data.closed) {
        await operation();
      }
    })
    .catch((error: unknown) => {
      logger.error(
        { error: formatError(error), socketId: data.socketId },
        "Subscription operation failed",
      );
      if (!data.closed) {
        sendError(ws, 4000, "Subscription operation failed");
      }
    });
}

function readSubscriptionFromPayload(
  payload: unknown,
): { channel: unknown; auth?: unknown; channelData?: unknown } | undefined {
  if (typeof payload === "string") {
    try {
      return readSubscriptionFromPayload(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }

  if (typeof payload !== "object" || payload === null || !("channel" in payload)) {
    return undefined;
  }

  const subscription = payload as {
    channel?: unknown;
    auth?: unknown;
    channel_data?: unknown;
  };
  return {
    channel: subscription.channel,
    ...(subscription.auth === undefined ? {} : { auth: subscription.auth }),
    ...(subscription.channel_data === undefined
      ? {}
      : { channelData: subscription.channel_data }),
  };
}

function readChannelFromPayload(payload: unknown): unknown {
  return readSubscriptionFromPayload(payload)?.channel;
}

function sendError(
  ws: uWS.WebSocket<SocketData>,
  code: number,
  message: string,
): void {
  if (ws.getUserData().closed) {
    return;
  }
  ws.send(encodePusherMessage(errorMessage(code, message)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { APP_NOT_FOUND_CLOSE_CODE, APP_NOT_FOUND_MESSAGE };

export function readClusterSize(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 1;
  }
  const clusterSize = Number(rawValue);
  if (!Number.isInteger(clusterSize) || clusterSize <= 0) {
    throw new Error("PULSEWS_CLUSTER_SIZE must be a positive integer");
  }
  return clusterSize;
}

export function resolveNodeId(rawValue: string | undefined): string {
  if (rawValue === undefined) {
    return randomUUID();
  }
  const nodeId = rawValue.trim();
  if (nodeId.length === 0 || nodeId.length > 100) {
    throw new Error("PULSEWS_NODE_ID must contain 1 to 100 characters");
  }
  return nodeId;
}
