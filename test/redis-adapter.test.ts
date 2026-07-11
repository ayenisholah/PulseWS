import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import {
  parseRedisEventEnvelope,
  RedisEventAdapter,
  redisEventChannel,
} from "../src/adapter/redis.js";

const appId = "demo-app";
const event = {
  appId,
  channel: "presence-room",
  event: "client-status",
  data: JSON.stringify({ online: true }),
  excludeSocket: "123.456",
  userId: "user-1",
};

describe("Redis event adapter", () => {
  test("subscribes once per app and delivers only from Redis echoes", async () => {
    const publisher = new FakeRedis();
    const subscriber = new FakeRedis();
    const receive = vi.fn(() => true);
    const logger = createLogger();
    const adapter = new RedisEventAdapter(
      "redis://unused",
      [appId, "second-app"],
      "node-a",
      { receive },
      logger,
      { publisher, subscriber },
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(123_456);

    await adapter.initialize();
    await adapter.initialize();
    expect(publisher.connect).toHaveBeenCalledOnce();
    expect(subscriber.connect).toHaveBeenCalledOnce();
    expect(subscriber.subscribe).toHaveBeenCalledOnce();
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      "pulsews:events:demo-app",
      "pulsews:events:second-app",
    );

    await expect(adapter.publish(event)).resolves.toBe(true);
    expect(receive).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith(
      redisEventChannel(appId),
      JSON.stringify({
        channel: event.channel,
        event: event.event,
        data: event.data,
        excludeSocket: event.excludeSocket,
        ts: 123_456,
        nodeId: "node-a",
        userId: event.userId,
      }),
    );

    subscriber.emit(
      "message",
      redisEventChannel(appId),
      publisher.publish.mock.calls[0]?.[1],
    );
    expect(receive).toHaveBeenCalledWith(event);

    now.mockRestore();
    await adapter.close();
    await adapter.close();
    expect(subscriber.unsubscribe).toHaveBeenCalledOnce();
    expect(publisher.quit).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });

  test("logs and drops malformed envelopes without stopping delivery", async () => {
    const publisher = new FakeRedis();
    const subscriber = new FakeRedis();
    const receive = vi.fn(() => true);
    const logger = createLogger();
    const adapter = new RedisEventAdapter(
      "redis://unused",
      [appId],
      "node-a",
      { receive },
      logger,
      { publisher, subscriber },
    );
    await adapter.initialize();

    for (const malformed of [
      "not-json",
      "[]",
      JSON.stringify({ channel: "room" }),
      JSON.stringify({
        channel: "room",
        event: "event",
        data: "{}",
        ts: "now",
        nodeId: "node-a",
      }),
    ]) {
      subscriber.emit("message", redisEventChannel(appId), malformed);
    }
    subscriber.emit(
      "message",
      redisEventChannel("unknown"),
      JSON.stringify(validEnvelope()),
    );

    expect(receive).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(5);

    subscriber.emit(
      "message",
      redisEventChannel(appId),
      JSON.stringify(validEnvelope()),
    );
    expect(receive).toHaveBeenCalledWith({
      appId,
      channel: "room",
      event: "event",
      data: "{}",
    });

    await adapter.close();
  });

  test("fails initialization instead of falling back when Redis is unavailable", async () => {
    const publisher = new FakeRedis();
    const subscriber = new FakeRedis();
    publisher.connect.mockRejectedValueOnce(new Error("connection refused"));
    const adapter = new RedisEventAdapter(
      "redis://unused",
      [appId],
      "node-a",
      { receive: () => true },
      createLogger(),
      { publisher, subscriber },
    );

    await expect(adapter.initialize()).rejects.toThrow(
      "Unable to initialize Redis event adapter: connection refused",
    );
    await expect(adapter.publish(event)).rejects.toThrow(
      "Redis event adapter is not initialized",
    );
  });
});

describe("Redis event envelope validation", () => {
  test("accepts the complete envelope and optional metadata", () => {
    expect(parseRedisEventEnvelope(JSON.stringify(validEnvelope()))).toEqual(
      validEnvelope(),
    );
    expect(
      parseRedisEventEnvelope(
        JSON.stringify({
          ...validEnvelope(),
          excludeSocket: "123.456",
          userId: "user-1",
        }),
      ),
    ).toEqual({
      ...validEnvelope(),
      excludeSocket: "123.456",
      userId: "user-1",
    });
  });
});

class FakeRedis extends EventEmitter {
  status = "wait";
  readonly connect = vi.fn(async () => {
    this.status = "ready";
  });
  readonly publish = vi.fn(async (_channel: string, _message: string) => 1);
  readonly eval = vi.fn(
    async (
      _script: string,
      _numberOfKeys: number,
      ..._arguments: string[]
    ) => [],
  );
  readonly call = vi.fn(async (_command: string, ..._arguments: string[]) => 1);
  readonly subscribe = vi.fn(async (..._channels: string[]) => 1);
  readonly unsubscribe = vi.fn(async (..._channels: string[]) => 1);
  readonly quit = vi.fn(async () => {
    this.status = "end";
    return "OK";
  });
  readonly disconnect = vi.fn(() => {
    this.status = "end";
  });
}

function createLogger() {
  return {
    warn: vi.fn((_details: Record<string, unknown>, _message: string) => {}),
    error: vi.fn((_details: Record<string, unknown>, _message: string) => {}),
  };
}

function validEnvelope() {
  return {
    channel: "room",
    event: "event",
    data: "{}",
    ts: 123,
    nodeId: "node-a",
  };
}
