import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { AppConfig } from "./config.js";

const AUTH_VERSION = "1.0";
const AUTH_TIMESTAMP_TOLERANCE_SECONDS = 600;
const MD5_HEX_LENGTH = 32;
const SHA256_HEX_LENGTH = 64;

export type SubscriptionAuthApp = Pick<AppConfig, "key" | "secret">;

export function createPrivateChannelAuth(
  app: SubscriptionAuthApp,
  socketId: string,
  channel: string,
): string {
  const signature = createHmac("sha256", app.secret)
    .update(`${socketId}:${channel}`)
    .digest("hex");

  return `${app.key}:${signature}`;
}

export function verifyPrivateChannelAuth(
  app: SubscriptionAuthApp,
  socketId: string,
  channel: string,
  auth: unknown,
): boolean {
  if (typeof auth !== "string") {
    return false;
  }

  const separator = auth.indexOf(":");
  if (separator < 1 || auth.slice(0, separator) !== app.key) {
    return false;
  }

  const actualSignature = auth.slice(separator + 1);
  const expectedSignature = createPrivateChannelAuth(app, socketId, channel)
    .slice(app.key.length + 1);

  return safeEqualHex(
    expectedSignature,
    actualSignature,
    SHA256_HEX_LENGTH,
  );
}

export function createPresenceChannelAuth(
  app: SubscriptionAuthApp,
  socketId: string,
  channel: string,
  channelData: string,
): string {
  const signature = createHmac("sha256", app.secret)
    .update(`${socketId}:${channel}:${channelData}`)
    .digest("hex");

  return `${app.key}:${signature}`;
}

export function verifyPresenceChannelAuth(
  app: SubscriptionAuthApp,
  socketId: string,
  channel: string,
  channelData: unknown,
  auth: unknown,
): boolean {
  if (typeof channelData !== "string" || typeof auth !== "string") {
    return false;
  }

  const separator = auth.indexOf(":");
  if (separator < 1 || auth.slice(0, separator) !== app.key) {
    return false;
  }

  const actualSignature = auth.slice(separator + 1);
  const expectedSignature = createPresenceChannelAuth(
    app,
    socketId,
    channel,
    channelData,
  ).slice(app.key.length + 1);
  return safeEqualHex(expectedSignature, actualSignature, SHA256_HEX_LENGTH);
}

export type RestAuthRequest = {
  app: Pick<AppConfig, "key" | "secret">;
  method: string;
  path: string;
  rawQuery: string;
  rawBody: Buffer;
};

export function verifyRestRequest(
  request: RestAuthRequest,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  const query = parseQuery(request.rawQuery);
  if (!query) {
    return false;
  }

  const authKey = query.values.get("auth_key");
  const authTimestamp = query.values.get("auth_timestamp");
  const authVersion = query.values.get("auth_version");
  const bodyMd5 = query.values.get("body_md5");

  if (
    authKey !== request.app.key ||
    authVersion !== AUTH_VERSION ||
    authTimestamp === undefined ||
    bodyMd5 === undefined ||
    !/^\d+$/.test(authTimestamp)
  ) {
    return false;
  }

  const timestamp = Number(authTimestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > AUTH_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const expectedBodyMd5 = createHash("md5")
    .update(request.rawBody)
    .digest("hex");
  if (!safeEqualHex(expectedBodyMd5, bodyMd5, MD5_HEX_LENGTH)) {
    return false;
  }

  const canonicalQuery = query.signedPairs
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const stringToSign = [
    request.method.toUpperCase(),
    request.path,
    canonicalQuery,
  ].join("\n");
  const expectedSignature = createHmac("sha256", request.app.secret)
    .update(stringToSign)
    .digest("hex");

  return safeEqualHex(
    expectedSignature,
    query.signature,
    SHA256_HEX_LENGTH,
  );
}

type ParsedQuery = {
  signature: string;
  signedPairs: Array<[string, string]>;
  values: Map<string, string>;
};

function parseQuery(rawQuery: string): ParsedQuery | undefined {
  const signedPairs: Array<[string, string]> = [];
  const values = new Map<string, string>();
  let signature: string | undefined;

  for (const part of rawQuery.split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      return undefined;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (values.has(key)) {
      return undefined;
    }
    values.set(key, value);

    if (key === "auth_signature") {
      signature = value;
    } else {
      signedPairs.push([key, value]);
    }
  }

  if (signature === undefined) {
    return undefined;
  }

  return { signature, signedPairs, values };
}

function safeEqualHex(expected: string, actual: string, length: number): boolean {
  if (
    expected.length !== length ||
    actual.length !== length ||
    !/^[0-9a-f]+$/.test(expected) ||
    !/^[0-9a-f]+$/.test(actual)
  ) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
