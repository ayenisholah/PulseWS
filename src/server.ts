import uWS, { type us_listen_socket } from "uWebSockets.js";

import { topicFor, validatePublicChannelName } from "./channels.js";
import type { AppConfig, PulseWsConfig } from "./config.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
  APP_NOT_FOUND_MESSAGE,
  DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
  channelEventMessage,
  connectionEstablishedMessage,
  createSocketId,
  decodeClientMessage,
  encodePusherMessage,
  errorMessage,
  pongMessage,
  subscriptionSucceededMessage,
} from "./protocol.js";

const DEFAULT_ACTIVITY_GRACE_SECONDS = 30;
const DEFAULT_REAPER_INTERVAL_MILLISECONDS = 1_000;

type SocketData =
  | {
      accepted: true;
      app: AppConfig;
      socketId: string;
      subscriptions: Set<string>;
      lastActivityAt: number;
      closed: boolean;
    }
  | {
      accepted: false;
      closed: boolean;
    };

export type PulseWsServer = {
  port: number;
  publish: (
    appId: string,
    channel: string,
    event: string,
    data: unknown,
  ) => boolean;
  close: () => void;
};

export type ServerTimingOptions = {
  activityTimeoutSeconds?: number;
  activityGraceSeconds?: number;
  reaperIntervalMilliseconds?: number;
};

export async function startServer(
  config: PulseWsConfig,
  timing: ServerTimingOptions = {},
): Promise<PulseWsServer> {
  const appsByKey = new Map(config.apps.map((app) => [app.key, app]));
  const app = uWS.App();
  const acceptedSockets = new Set<uWS.WebSocket<SocketData>>();
  const activityTimeoutSeconds =
    timing.activityTimeoutSeconds ?? DEFAULT_ACTIVITY_TIMEOUT_SECONDS;
  const activityGraceSeconds =
    timing.activityGraceSeconds ?? DEFAULT_ACTIVITY_GRACE_SECONDS;
  const reaperIntervalMilliseconds =
    timing.reaperIntervalMilliseconds ??
    DEFAULT_REAPER_INTERVAL_MILLISECONDS;

  app.ws<SocketData>("/app/:key", {
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

      data.lastActivityAt = Date.now();
      acceptedSockets.add(ws);
      ws.send(
        encodePusherMessage(
          connectionEstablishedMessage(data.socketId, activityTimeoutSeconds),
        ),
      );
    },
    message: (ws, message) => {
      const data = ws.getUserData();
      if (!data.accepted) {
        return;
      }
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
        handleSubscribe(ws, clientMessage.data);
        return;
      }

      if (clientMessage.event === "pusher:unsubscribe") {
        handleUnsubscribe(ws, clientMessage.data);
      }
    },
    close: (ws) => {
      const data = ws.getUserData();
      data.closed = true;
      if (data.accepted) {
        acceptedSockets.delete(ws);
        data.subscriptions.clear();
      }
    },
  });

  const listenSocket = await listen(app, config.port);
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

  return {
    port: boundPort,
    publish: (appId, channel, event, data) =>
      app.publish(
        topicFor(appId, channel),
        encodePusherMessage(channelEventMessage(channel, event, data)),
      ),
    close: () => {
      clearInterval(reaper);
      uWS.us_listen_socket_close(listenSocket);
    },
  };
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

function handleSubscribe(ws: uWS.WebSocket<SocketData>, payload: unknown): void {
  const channel = readChannelFromPayload(payload);
  const validation = validatePublicChannelName(channel);

  if (!validation.ok) {
    sendError(ws, 4000, validation.reason);
    return;
  }

  const data = ws.getUserData();
  if (!data.accepted) {
    return;
  }

  const topic = topicFor(data.app.id, validation.channel);
  ws.subscribe(topic);
  data.subscriptions.add(validation.channel);
  ws.send(
    encodePusherMessage(subscriptionSucceededMessage(validation.channel)),
  );
}

function handleUnsubscribe(ws: uWS.WebSocket<SocketData>, payload: unknown): void {
  const channel = readChannelFromPayload(payload);
  const validation = validatePublicChannelName(channel);

  if (!validation.ok) {
    sendError(ws, 4000, validation.reason);
    return;
  }

  const data = ws.getUserData();
  if (!data.accepted) {
    return;
  }

  ws.unsubscribe(topicFor(data.app.id, validation.channel));
  data.subscriptions.delete(validation.channel);
}

function readChannelFromPayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return readChannelFromPayload(JSON.parse(payload));
    } catch {
      return undefined;
    }
  }

  if (typeof payload !== "object" || payload === null || !("channel" in payload)) {
    return undefined;
  }

  return (payload as { channel?: unknown }).channel;
}

function sendError(
  ws: uWS.WebSocket<SocketData>,
  code: number,
  message: string,
): void {
  ws.send(encodePusherMessage(errorMessage(code, message)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { APP_NOT_FOUND_CLOSE_CODE, APP_NOT_FOUND_MESSAGE };
