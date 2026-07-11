import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { authorizeDemoPresence, loadDemoAssets } from "../src/demo.js";

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

  test("includes complete discoverability and social metadata", async () => {
    const assets = await loadDemoAssets();
    const html = assets.html.toString("utf8");
    const manifest = JSON.parse(
      assets.public
        .find(({ path }) => path === "/site.webmanifest")!
        .body.toString("utf8"),
    ) as { name: string; icons: Array<{ sizes: string }> };

    expect(html).toContain(
      '<link rel="canonical" href="https://pulsews.jobrail.xyz/"',
    );
    expect(html).toContain('property="og:image"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    expect(manifest.name).toBe("PulseWS Live Console");
    expect(manifest.icons.map(({ sizes }) => sizes)).toEqual(["192x192", "512x512"]);
    expect(assets.public.map(({ path }) => path)).toContain("/sitemap.xml");
  });
});

function form(fields: Record<string, string>): Buffer {
  return Buffer.from(new URLSearchParams(fields).toString());
}
