import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createPresenceChannelAuth,
  createPrivateChannelAuth,
} from "../../src/auth.js";
import {
  classifyChannelName,
  isValidChannelName,
} from "../../src/channels.js";

export type AuthServerOptions = {
  appKey: string;
  appSecret: string;
  port?: number;
  host?: string;
};

export type RunningAuthServer = {
  port: number;
  close: () => Promise<void>;
};

export async function startAuthServer(
  options: AuthServerOptions,
): Promise<RunningAuthServer> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/pusher/auth") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const body = await readBody(request);
    const form = new URLSearchParams(body);
    const socketId = form.get("socket_id");
    const channel = form.get("channel_name");

    if (!socketId || !channel || !isValidChannelName(channel)) {
      sendJson(response, 403, { error: "Channel authorization denied" });
      return;
    }

    const channelType = classifyChannelName(channel);
    if (channelType === "presence") {
      const userId = form.get("user_id");
      const userInfo = parseUserInfo(form.get("user_info"));
      if (!userId || !userInfo) {
        sendJson(response, 403, { error: "Presence authorization denied" });
        return;
      }

      const channelData = JSON.stringify({
        user_id: userId,
        user_info: userInfo,
      });
      sendJson(response, 200, {
        auth: createPresenceChannelAuth(
          { key: options.appKey, secret: options.appSecret },
          socketId,
          channel,
          channelData,
        ),
        channel_data: channelData,
      });
      return;
    }

    if (channelType !== "private") {
      sendJson(response, 403, { error: "Channel authorization denied" });
      return;
    }

    sendJson(response, 200, {
      auth: createPrivateChannelAuth(
        { key: options.appKey, secret: options.appSecret },
        socketId,
        channel,
      ),
    });
  });

  await listen(server, options.port ?? 3001, options.host ?? "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine auth server port");
  }

  return {
    port: address.port,
    close: () => close(server),
  };
}

function parseUserInfo(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const entrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (entrypoint) {
  const running = await startAuthServer({
    appKey: requiredEnvironment("PULSEWS_APP_KEY"),
    appSecret: requiredEnvironment("PULSEWS_APP_SECRET"),
    port: Number(process.env.PORT ?? "3001"),
  });
  console.log(`PulseWS auth example listening on http://127.0.0.1:${running.port}`);
}
