import uWS, { type us_listen_socket } from "uWebSockets.js";

import type { AppConfig, PulseWsConfig } from "./config.js";
import {
  APP_NOT_FOUND_CLOSE_CODE,
  APP_NOT_FOUND_MESSAGE,
  connectionEstablishedMessage,
  createSocketId,
  encodePusherMessage,
  errorMessage,
} from "./protocol.js";

type SocketData =
  | {
      accepted: true;
      app: AppConfig;
      socketId: string;
    }
  | {
      accepted: false;
    };

export type PulseWsServer = {
  port: number;
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
            }
          : {
              accepted: false,
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
        setTimeout(() => {
          ws.close();
        }, 10);
        return;
      }

      ws.send(encodePusherMessage(connectionEstablishedMessage(data.socketId)));
    },
  });

  const listenSocket = await listen(app, config.port);
  const boundPort = uWS.us_socket_local_port(listenSocket);

  return {
    port: boundPort,
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

export { APP_NOT_FOUND_CLOSE_CODE, APP_NOT_FOUND_MESSAGE };
