import { readFile } from "node:fs/promises";

import { createPresenceChannelAuth } from "./auth.js";
import type { AppConfig } from "./config.js";

export type DemoAssets = {
  html: Buffer;
  css: Buffer;
  javascript: Buffer;
  public: ReadonlyArray<{
    path: string;
    body: Buffer;
    contentType: string;
  }>;
};

export type DemoAuthorization = {
  auth: string;
  channel_data: string;
};

export async function loadDemoAssets(): Promise<DemoAssets> {
  const publicAssets = [
    ["/favicon.svg", "favicon.svg", "image/svg+xml; charset=utf-8"],
    ["/favicon-16x16.png", "favicon-16x16.png", "image/png"],
    ["/favicon-32x32.png", "favicon-32x32.png", "image/png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "icon-192.png", "image/png"],
    ["/icon-512.png", "icon-512.png", "image/png"],
    ["/logo.svg", "logo.svg", "image/svg+xml; charset=utf-8"],
    ["/og-pulsews.png", "og-pulsews.png", "image/png"],
    [
      "/site.webmanifest",
      "site.webmanifest",
      "application/manifest+json; charset=utf-8",
    ],
    ["/robots.txt", "robots.txt", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "sitemap.xml", "application/xml; charset=utf-8"],
  ] as const;
  const [html, css, javascript, ...publicBodies] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url)),
    readFile(new URL("../public/styles.css", import.meta.url)),
    readFile(new URL("../public/demo.js", import.meta.url)),
    ...publicAssets.map(([, filename]) =>
      readFile(new URL(`../public/${filename}`, import.meta.url)),
    ),
  ]);
  return {
    html,
    css,
    javascript,
    public: publicAssets.map(([path, , contentType], index) => ({
      path,
      body: publicBodies[index]!,
      contentType,
    })),
  };
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
