import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { authorizeDemoPresence } from "../src/demo.js";

const app = { key: "demo-key", secret: "demo-secret" };

describe("demo presence authorization", () => {
  test("returns signed channel data for the configured channel", () => {
    const authorization = authorizeDemoPresence(
      app,
      "presence-demo",
      form({
        socket_id: "123.456",
        channel_name: "presence-demo",
        user_id: "guest-123",
        user_info: JSON.stringify({ name: "Guest 123" }),
      }),
    );

    expect(JSON.parse(authorization.channel_data)).toEqual({
      user_id: "guest-123",
      user_info: { name: "Guest 123" },
    });
    expect(authorization.auth).toMatch(/^demo-key:[0-9a-f]{64}$/);
  });

  test("rejects wrong channels and malformed guest fields", () => {
    const cases = [
      { socket_id: "bad", channel_name: "presence-demo", user_id: "guest" },
      { socket_id: "1.2", channel_name: "presence-other", user_id: "guest" },
      { socket_id: "1.2", channel_name: "presence-demo", user_id: "" },
      {
        socket_id: "1.2",
        channel_name: "presence-demo",
        user_id: "guest",
        user_info: "[]",
      },
    ];
    for (const fields of cases) {
      expect(() =>
        authorizeDemoPresence(app, "presence-demo", form(fields)),
      ).toThrow();
    }
  });
});

describe("demo assets", () => {
  test("uses pinned pusher-js and implements live bounded client events", async () => {
    const [html, javascript] = await Promise.all([
      readFile(new URL("../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/demo.js", import.meta.url), "utf8"),
    ]);

    expect(html).toContain("pusher-js@8.5.0/dist/web/pusher.min.js");
    expect(javascript).toContain('pusher.subscribe(config.channel)');
    expect(javascript).toContain('pusher.bind("pulsews:node"');
    expect(javascript).toContain('channel.trigger("client-demo-message"');
    expect(javascript).toContain("MAX_LOG_ENTRIES");
  });
});

function form(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString());
}
