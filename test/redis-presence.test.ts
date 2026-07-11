import { describe, expect, test, vi } from "vitest";

import {
  presenceKey,
  RedisPresenceRegistry,
} from "../src/redis-presence.js";

const member = { userId: "user-1", userInfo: { name: "Ada" } };

describe("Redis presence registry", () => {
  test("stores node-aware membership and builds a unique-user roster", async () => {
    const evalScript = vi.fn(async () => [
      1,
      1,
      stored("user-1", { name: "Ada" }, "node-a"),
      stored("user-1", { name: "Ada" }, "node-b"),
      stored("user-2", { name: "Grace" }, "node-b"),
    ]);
    const registry = new RedisPresenceRegistry({ eval: evalScript }, "node-a");

    await expect(
      registry.join("app", "presence-room", "1.1", member),
    ).resolves.toEqual({
      ok: true,
      memberAdded: true,
      roster: {
        presence: {
          ids: ["user-1", "user-2"],
          hash: {
            "user-1": { name: "Ada" },
            "user-2": { name: "Grace" },
          },
          count: 2,
        },
      },
    });
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('HSET'"),
      1,
      presenceKey("app", "presence-room"),
      "1.1",
      JSON.stringify({
        user_id: "user-1",
        user_info: { name: "Ada" },
        node_id: "node-a",
      }),
    );
  });

  test("returns identity conflicts from the atomic join script", async () => {
    const registry = new RedisPresenceRegistry(
      {
        eval: vi.fn(async () => [
          0,
          "A socket cannot change presence identity while subscribed",
        ]),
      },
      "node-a",
    );

    await expect(
      registry.join("app", "presence-room", "1.1", member),
    ).resolves.toEqual({
      ok: false,
      reason: "A socket cannot change presence identity while subscribed",
    });
  });

  test("emits removal only for the final identity socket", async () => {
    const evalScript = vi
      .fn()
      .mockResolvedValueOnce([0])
      .mockResolvedValueOnce([1, stored("user-1", { name: "Ada" }, "node-a")]);
    const registry = new RedisPresenceRegistry({ eval: evalScript }, "node-a");

    await expect(
      registry.leave("app", "presence-room", "1.1"),
    ).resolves.toEqual({ memberRemoved: false });
    await expect(
      registry.leave("app", "presence-room", "1.2"),
    ).resolves.toEqual({ memberRemoved: true, member });
    expect(evalScript).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('HDEL'"),
      1,
      "pulsews:presence:app:presence-room",
      "1.2",
    );
  });

  test("rejects malformed script results and stored membership", async () => {
    const invalidResults = [
      "not-an-array",
      [2, 1],
      [1, 2],
      [1, 1, "not-json"],
      [1, 1, JSON.stringify({ user_id: "user-1" })],
    ];
    for (const result of invalidResults) {
      const registry = new RedisPresenceRegistry(
        { eval: vi.fn(async () => result) },
        "node-a",
      );
      await expect(
        registry.join("app", "presence-room", "1.1", member),
      ).rejects.toThrow();
    }
  });
});

function stored(
  userId: string,
  userInfo: Record<string, unknown>,
  nodeId: string,
): string {
  return JSON.stringify({
    user_id: userId,
    user_info: userInfo,
    node_id: nodeId,
  });
}
