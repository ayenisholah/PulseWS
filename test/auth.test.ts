import Pusher from "pusher";
import { describe, expect, test, vi } from "vitest";

import {
  createPresenceChannelAuth,
  createPrivateChannelAuth,
  verifyPresenceChannelAuth,
  verifyPrivateChannelAuth,
  verifyRestRequest,
} from "../src/auth.js";

const app = {
  key: "demo-key",
  secret: "demo-secret",
};
const path = "/apps/demo-app/events";
const body = JSON.stringify({
  name: "demo.event",
  channels: ["public-updates"],
  data: JSON.stringify({ ok: true }),
});
const sdk = new Pusher({
  appId: "demo-app",
  key: app.key,
  secret: app.secret,
  host: "127.0.0.1",
  useTLS: false,
});

describe("private channel authentication", () => {
  test("matches the official SDK authorization fixture", () => {
    const socketId = "1234.5678";
    const channel = "private-room";
    const fixture = sdk.authorizeChannel(socketId, channel);

    expect(createPrivateChannelAuth(app, socketId, channel)).toBe(fixture.auth);
    expect(
      verifyPrivateChannelAuth(app, socketId, channel, fixture.auth),
    ).toBe(true);
  });

  test("rejects missing, malformed, wrong-key, and tampered authorization", () => {
    const valid = createPrivateChannelAuth(app, "1234.5678", "private-room");
    const cases: unknown[] = [
      undefined,
      null,
      "",
      "demo-key:not-hex",
      `demo-key:${"0".repeat(62)}`,
      valid.replace("demo-key:", "wrong-key:"),
      `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`,
    ];

    for (const auth of cases) {
      expect(
        verifyPrivateChannelAuth(app, "1234.5678", "private-room", auth),
      ).toBe(false);
    }
  });
});

describe("presence channel authentication", () => {
  test("matches the official SDK authorization fixture", () => {
    const socketId = "1234.5678";
    const channel = "presence-room";
    const member = { user_id: "user-1", user_info: { name: "Ada" } };
    const fixture = sdk.authorizeChannel(socketId, channel, member);

    expect(
      createPresenceChannelAuth(
        app,
        socketId,
        channel,
        fixture.channel_data as string,
      ),
    ).toBe(fixture.auth);
    expect(
      verifyPresenceChannelAuth(
        app,
        socketId,
        channel,
        fixture.channel_data,
        fixture.auth,
      ),
    ).toBe(true);
  });

  test("rejects tampered auth and channel data", () => {
    const channelData = JSON.stringify({ user_id: "user-1" });
    const auth = createPresenceChannelAuth(
      app,
      "1234.5678",
      "presence-room",
      channelData,
    );

    expect(
      verifyPresenceChannelAuth(
        app,
        "1234.5678",
        "presence-room",
        `${channelData} `,
        auth,
      ),
    ).toBe(false);
    expect(
      verifyPresenceChannelAuth(
        app,
        "1234.5678",
        "presence-room",
        channelData,
        `${auth.slice(0, -1)}0`,
      ),
    ).toBe(false);
  });
});

describe("REST request authentication", () => {
  test("accepts an official SDK fixture regardless of incoming query order", () => {
    const nowSeconds = 1_700_000_000;
    const signedQuery = createSdkQuery(body, nowSeconds);
    const reorderedQuery = signedQuery.split("&").reverse().join("&");

    expect(verify(reorderedQuery, body, nowSeconds)).toBe(true);
  });

  test("accepts timestamps at both edges of the 600 second window", () => {
    const nowSeconds = 1_700_000_000;

    expect(verify(createSdkQuery(body, nowSeconds - 600), body, nowSeconds)).toBe(
      true,
    );
    expect(verify(createSdkQuery(body, nowSeconds + 600), body, nowSeconds)).toBe(
      true,
    );
  });

  test("rejects correctly signed timestamps outside the 600 second window", () => {
    const nowSeconds = 1_700_000_000;

    expect(verify(createSdkQuery(body, nowSeconds - 601), body, nowSeconds)).toBe(
      false,
    );
    expect(verify(createSdkQuery(body, nowSeconds + 601), body, nowSeconds)).toBe(
      false,
    );
  });

  test("rejects tampered signatures and bodies", () => {
    const nowSeconds = 1_700_000_000;
    const signedQuery = createSdkQuery(body, nowSeconds);
    const tamperedSignature = replaceQueryValue(
      signedQuery,
      "auth_signature",
      "0".repeat(64),
    );

    expect(verify(tamperedSignature, body, nowSeconds)).toBe(false);
    expect(verify(signedQuery, `${body} `, nowSeconds)).toBe(false);
  });

  test("rejects missing or incorrect required authentication fields", () => {
    const nowSeconds = 1_700_000_000;
    const signedQuery = createSdkQuery(body, nowSeconds);
    const cases = [
      removeQueryField(signedQuery, "auth_signature"),
      removeQueryField(signedQuery, "auth_timestamp"),
      removeQueryField(signedQuery, "body_md5"),
      replaceQueryValue(signedQuery, "auth_key", "wrong-key"),
      replaceQueryValue(signedQuery, "auth_version", "2.0"),
      replaceQueryValue(signedQuery, "auth_timestamp", "not-a-timestamp"),
    ];

    for (const rawQuery of cases) {
      expect(verify(rawQuery, body, nowSeconds)).toBe(false);
    }
  });
});

function verify(
  rawQuery: string,
  rawBody: string,
  nowSeconds: number,
): boolean {
  return verifyRestRequest(
    {
      app,
      method: "POST",
      path,
      rawQuery,
      rawBody: Buffer.from(rawBody),
    },
    nowSeconds,
  );
}

function createSdkQuery(rawBody: string, timestamp: number): string {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(timestamp * 1_000);
  try {
    return sdk.createSignedQueryString({
      method: "POST",
      path,
      body: rawBody,
    });
  } finally {
    dateNow.mockRestore();
  }
}

function replaceQueryValue(
  rawQuery: string,
  key: string,
  replacement: string,
): string {
  return rawQuery
    .split("&")
    .map((part) => (part.startsWith(`${key}=`) ? `${key}=${replacement}` : part))
    .join("&");
}

function removeQueryField(rawQuery: string, key: string): string {
  return rawQuery
    .split("&")
    .filter((part) => !part.startsWith(`${key}=`))
    .join("&");
}
