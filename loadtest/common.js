import crypto from "k6/crypto";

export const baseUrl = (__ENV.PULSEWS_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
export const appId = __ENV.PULSEWS_APP_ID || "demo-app";
export const appKey = __ENV.PULSEWS_APP_KEY || "demo-key";
export const appSecret = __ENV.PULSEWS_APP_SECRET || "change-me";
export const channelCount = positiveInteger("PULSEWS_CHANNELS", 32);
export const duration = __ENV.PULSEWS_DURATION || "1m";

export function positiveInteger(name, fallback) {
  const value = Number.parseInt(__ENV[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function wsUrl(targetUrl = baseUrl) {
  return `${targetUrl.replace(/\/$/, "").replace(/^http/, "ws")}/app/${encodeURIComponent(appKey)}?protocol=7&client=k6&version=1.0`;
}

export function channelFor(index) {
  return `load-${index % channelCount}`;
}

export function subscribeMessage(channel) {
  return JSON.stringify({ event: "pusher:subscribe", data: { channel } });
}

export function signedPublish(channel, event, data, targetUrl = baseUrl) {
  const body = JSON.stringify({ name: event, channels: [channel], data: JSON.stringify(data) });
  const path = `/apps/${appId}/events`;
  const query = {
    auth_key: appKey,
    auth_timestamp: String(Math.floor(Date.now() / 1000)),
    auth_version: "1.0",
    body_md5: crypto.md5(body, "hex"),
  };
  const canonical = Object.keys(query)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join("&");
  query.auth_signature = crypto.hmac("sha256", appSecret, `POST\n${path}\n${canonical}`, "hex");
  const signedQuery = Object.keys(query)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
    .join("&");
  return { url: `${targetUrl.replace(/\/$/, "")}${path}?${signedQuery}`, body };
}
