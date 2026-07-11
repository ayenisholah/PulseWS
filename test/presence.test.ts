import { describe, expect, test } from "vitest";

import {
  LocalPresenceRegistry,
  parsePresenceChannelData,
} from "../src/presence.js";

describe("presence channel data", () => {
  test("parses a user and defaults missing user info", () => {
    expect(parsePresenceChannelData('{"user_id":"user-1"}')).toEqual({
      userId: "user-1",
      userInfo: {},
    });
  });

  test("rejects malformed identities and non-object user info", () => {
    for (const value of [
      undefined,
      "not json",
      "[]",
      "{}",
      '{"user_id":""}',
      '{"user_id":"user-1","user_info":[]}',
    ]) {
      expect(() => parsePresenceChannelData(value)).toThrow();
    }
  });
});

describe("local presence registry", () => {
  test("builds unique-user rosters across multiple sockets", async () => {
    const registry = new LocalPresenceRegistry();
    const ada = { userId: "user-1", userInfo: { name: "Ada" } };
    const grace = { userId: "user-2", userInfo: { name: "Grace" } };

    await expect(
      registry.join("app", "presence-room", "1.1", ada),
    ).resolves.toEqual({
      ok: true,
      memberAdded: true,
      roster: {
        presence: {
          ids: ["user-1"],
          hash: { "user-1": { name: "Ada" } },
          count: 1,
        },
      },
    });
    await expect(
      registry.join("app", "presence-room", "1.2", {
        userId: "user-1",
        userInfo: { name: "Ignored duplicate" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      memberAdded: false,
      roster: { presence: { count: 1 } },
    });
    await expect(
      registry.join("app", "presence-room", "2.1", grace),
    ).resolves.toMatchObject({
      ok: true,
      memberAdded: true,
      roster: { presence: { count: 2 } },
    });
  });

  test("emits removal only when the final socket leaves", async () => {
    const registry = new LocalPresenceRegistry();
    const member = { userId: "user-1", userInfo: { name: "Ada" } };
    await registry.join("app", "presence-room", "1.1", member);
    await registry.join("app", "presence-room", "1.2", member);

    await expect(
      registry.leave("app", "presence-room", "1.1"),
    ).resolves.toEqual({
      memberRemoved: false,
    });
    await expect(
      registry.leave("app", "presence-room", "1.2"),
    ).resolves.toEqual({
      memberRemoved: true,
      member,
    });
    await expect(
      registry.leave("app", "presence-room", "1.2"),
    ).resolves.toEqual({
      memberRemoved: false,
    });
  });

  test("is idempotent for one identity and rejects identity changes", async () => {
    const registry = new LocalPresenceRegistry();
    const member = { userId: "user-1", userInfo: {} };
    await registry.join("app", "presence-room", "1.1", member);

    await expect(
      registry.join("app", "presence-room", "1.1", member),
    ).resolves.toMatchObject({ ok: true, memberAdded: false });
    await expect(
      registry.join("app", "presence-room", "1.1", {
        userId: "user-2",
        userInfo: {},
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
