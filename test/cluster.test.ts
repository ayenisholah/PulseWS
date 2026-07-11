import { describe, expect, test, vi } from "vitest";

import {
  connectionCountKey,
  heartbeatKey,
  LocalConnectionCoordinator,
  RedisClusterCoordinator,
} from "../src/cluster.js";
import {
  nodeSocketsKey,
  RedisPresenceRegistry,
} from "../src/redis-presence.js";

describe("local connection coordinator", () => {
  test("enforces app caps and releases reservations idempotently", async () => {
    const coordinator = new LocalConnectionCoordinator();
    await coordinator.initialize();

    await expect(
      coordinator.reserveConnection("app", "1.1", 1),
    ).resolves.toBe(true);
    await expect(
      coordinator.reserveConnection("app", "1.2", 1),
    ).resolves.toBe(false);
    await coordinator.releaseConnection("app", "1.1");
    await coordinator.releaseConnection("app", "1.1");
    await expect(
      coordinator.reserveConnection("app", "1.3", 1),
    ).resolves.toBe(true);
  });
});

describe("Redis cluster coordinator", () => {
  test("registers heartbeats and reserves connections atomically", async () => {
    const redis = new FakeClusterRedis();
    const presence = new RedisPresenceRegistry(redis, "node-a");
    const coordinator = new RedisClusterCoordinator(
      redis,
      presence,
      { publish: vi.fn(async () => true) },
      "node-a",
      createLogger(),
    );

    await coordinator.initialize();
    await expect(
      coordinator.reserveConnection("app", "1.1", 5),
    ).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SADD', KEYS[1], ARGV[1])"),
      2,
      "pulsews:nodes",
      heartbeatKey("node-a"),
      "node-a",
      "30",
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("current >= tonumber(ARGV[1])"),
      2,
      connectionCountKey("app"),
      nodeSocketsKey("node-a"),
      "5",
      JSON.stringify({
        app_id: "app",
        socket_id: "1.1",
        presence_channels: [],
      }),
    );

    await coordinator.releaseConnection("app", "1.1");
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SREM', KEYS[2], ARGV[1])"),
      2,
      connectionCountKey("app"),
      nodeSocketsKey("node-a"),
      expect.any(String),
    );
    await coordinator.close();
  });

  test("sweeps dead socket records and publishes final member removals", async () => {
    const record = JSON.stringify({
      app_id: "app",
      socket_id: "1.1",
      presence_channels: ["presence-room"],
    });
    const redis = new FakeClusterRedis();
    redis.call.mockImplementation(async (command: string, ...arguments_: string[]) => {
      if (command === "SMEMBERS" && arguments_[0] === "pulsews:nodes") {
        return ["node-dead"];
      }
      if (command === "EXISTS") {
        return 0;
      }
      if (
        command === "SMEMBERS" &&
        arguments_[0] === nodeSocketsKey("node-dead")
      ) {
        return [record];
      }
      return 1;
    });
    redis.eval.mockImplementation(
      async (script: string, _keys: number, ..._arguments: string[]) => {
        if (script.includes("local removed = {}")) {
          return [
            1,
            JSON.stringify({
              channel: "presence-room",
              user_id: "user-1",
            }),
          ];
        }
        return 1;
      },
    );
    const publish = vi.fn(async () => true);
    const presence = new RedisPresenceRegistry(redis, "node-live");
    const coordinator = new RedisClusterCoordinator(
      redis,
      presence,
      { publish },
      "node-live",
      createLogger(),
    );
    await coordinator.initialize();

    await coordinator.sweepDeadNodes();

    expect(publish).toHaveBeenCalledWith({
      appId: "app",
      channel: "presence-room",
      event: "pusher_internal:member_removed",
      data: JSON.stringify({ user_id: "user-1" }),
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("local removed = {}"),
      4,
      heartbeatKey("node-dead"),
      nodeSocketsKey("node-dead"),
      connectionCountKey("app"),
      "pulsews:presence:app:presence-room",
      record,
      "1.1",
      "presence-room",
    );
    await coordinator.close();
  });
});

class FakeClusterRedis {
  readonly eval = vi.fn(
    async (
      _script: string,
      _numberOfKeys: number,
      ..._arguments: string[]
    ): Promise<unknown> => 1,
  );
  readonly call = vi.fn(
    async (_command: string, ..._arguments: string[]): Promise<unknown> => [],
  );
}

function createLogger() {
  return {
    warn: vi.fn((_details: Record<string, unknown>, _message: string) => {}),
    error: vi.fn((_details: Record<string, unknown>, _message: string) => {}),
  };
}
