import uWS, { type us_listen_socket } from "uWebSockets.js";

import { topicFor, validatePublicChannelName } from "./channels.js";
import type { AppConfig, PulseWsConfig } from "./config.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
  APP_NOT_FOUND_MESSAGE,
  channelEventMessage,
  connectionEstablishedMessage,
  createSocketId,
  decodeClientMessage,
  encodePusherMessage,
  errorMessage,
  subscriptionSucceededMessage,
} from "./protocol.js";

type SocketData =
  | {
      accepted: true;
      app: AppConfig;
      socketId: string;
      subscriptions: Set<string>;
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

export async function startServer(config: PulseWsConfig): Promise<PulseWsServer> {
  const appsByKey = new Map(config.apps.map((app) => [app.key, app]));
  const app = uWS.App();

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

      ws.send(encodePusherMessage(connectionEstablishedMessage(data.socketId)));
    },
    message: (ws, message) => {
      const data = ws.getUserData();
      if (!data.accepted) {
        return;
      }

      let clientMessage;
      try {
        clientMessage = decodeClientMessage(Buffer.from(message).toString("utf8"));
      } catch (error) {
        sendError(ws, 4000, formatError(error));
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
        data.subscriptions.clear();
      }
    },
  });

  const listenSocket = await listen(app, config.port);
  const boundPort = uWS.us_socket_local_port(listenSocket);

  return {
    port: boundPort,
    publish: (appId, channel, event, data) =>
      app.publish(
        topicFor(appId, channel),
        encodePusherMessage(channelEventMessage(channel, event, data)),
      ),
    close: () => {
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
