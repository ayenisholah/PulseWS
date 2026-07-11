import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { loadConfig, parseConfig } from "../src/config.js";

const validConfig = {
  port: 6001,
  redisUrl: "redis://localhost:6379",
  apps: [
    {
      id: "demo-app",
      key: "demo-key",
      secret: "demo-secret",
      maxConnections: 1000,
      maxClientEventsPerSecond: 10,
      maxRestPublishesPerSecond: 100,
    },
  ],
};

describe("config loader", () => {
  test("parses a valid config object", () => {
    expect(parseConfig(validConfig)).toEqual(validConfig);
  });

  test("defaults the optional REST publish allowance to 100 per second", () => {
    const app = { ...validConfig.apps[0] };
    delete (app as Partial<typeof app>).maxRestPublishesPerSecond;

    expect(parseConfig({ ...validConfig, apps: [app] }).apps[0]).toMatchObject({
      maxRestPublishesPerSecond: 100,
    });
  });

  test("accepts an opt-in demo for a configured app and presence channel", () => {
    const demo = { appKey: "demo-key", channel: "presence-demo" };
    expect(parseConfig({ ...validConfig, demo })).toEqual({
      ...validConfig,
      demo,
    });
  });

  test("rejects demo configuration for unknown apps or non-presence channels", () => {
    expect(() =>
      parseConfig({
        ...validConfig,
        demo: { appKey: "unknown", channel: "presence-demo" },
      }),
    ).toThrow(/demo\.appKey: appKey must match a configured application/);
    expect(() =>
      parseConfig({
        ...validConfig,
        demo: { appKey: "demo-key", channel: "public-demo" },
      }),
    ).toThrow(/demo\.channel: channel must be a valid presence channel/);
  });

  test("rejects invalid config with readable field paths", () => {
    expect(() =>
      parseConfig({
        ...validConfig,
        apps: [{ ...validConfig.apps[0], secret: "" }],
      }),
    ).toThrow(/apps\.0\.secret: secret is required/);
  });

  test("loads config from a JSON file", async () => {
    const configPath = await writeTempConfig(JSON.stringify(validConfig));

    await expect(loadConfig(configPath)).resolves.toEqual(validConfig);
  });

  test("reports malformed JSON with file context", async () => {
    const configPath = await writeTempConfig("{not-json");

    await expect(loadConfig(configPath)).rejects.toThrow(
      new RegExp(`Invalid JSON in PulseWS config at ${escapeRegExp(configPath)}`),
    );
  });
});

async function writeTempConfig(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pulsews-config-"));
  const configPath = join(directory, "pulsews.config.json");
  await writeFile(configPath, contents, "utf8");
  return configPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
