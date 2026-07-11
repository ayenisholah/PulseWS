import { readFile } from "node:fs/promises";

import { createPresenceChannelAuth } from "./auth.js";
import type { AppConfig } from "./config.js";

export type DemoAssets = {
  html: Buffer;
  css: Buffer;
  javascript: Buffer;
};

export type DemoAuthorization = {
  auth: string;
  channel_data: string;
};

export async function loadDemoAssets(): Promise<DemoAssets> {
  const [html, css, javascript] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url)),
    readFile(new URL("../public/styles.css", import.meta.url)),
    readFile(new URL("../public/demo.js", import.meta.url)),
  ]);
  return { html, css, javascript };
}

export function authorizeDemoPresence(
  app: Pick<AppConfig, "key" | "secret">,
  configuredChannel: string,
  rawBody: Buffer,
): DemoAuthorization {
  const form = new URLSearchParams(rawBody.toString("utf8"));
  const socketId = form.get("socket_id");
  const channel = form.get("channel_name");
  const userId = form.get("user_id");
  const userInfo = parseUserInfo(form.get("user_info"));

  if (!socketId || !/^\d+\.\d+$/.test(socketId)) {
    throw new Error("Demo socket_id is invalid");
  }
  if (channel !== configuredChannel) {
    throw new Error("Demo channel is not authorized");
  }
  if (!userId || userId.length > 100) {
    throw new Error("Demo user_id is invalid");
  }
  if (!userInfo) {
    throw new Error("Demo user_info is invalid");
  }

  const channelData = JSON.stringify({
    user_id: userId,
    user_info: userInfo,
  });
  return {
    auth: createPresenceChannelAuth(
      app,
      socketId,
      configuredChannel,
      channelData,
    ),
    channel_data: channelData,
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
