import { Redis } from "ioredis";

import type { EventAdapter, EventPublish } from "./types.js";

const EVENT_CHANNEL_PREFIX = "pulsews:events:";

type AdapterLogger = {
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
};

type RedisPublisher = {
  status: string;
  connect: () => Promise<void>;
  publish: (channel: string, message: string) => Promise<number>;
  eval: (
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ) => Promise<unknown>;
  call: (command: string, ...arguments_: string[]) => Promise<unknown>;
  quit: () => Promise<unknown>;
  disconnect: () => void;
  on: (event: "error", listener: (error: Error) => void) => unknown;
};

type RedisSubscriber = RedisPublisher & {
  subscribe: (...channels: string[]) => Promise<unknown>;
  unsubscribe: (...channels: string[]) => Promise<unknown>;
  on: {
    (event: "error", listener: (error: Error) => void): unknown;
    (
      event: "message",
      listener: (channel: string, message: string) => void,
    ): unknown;
  };
  removeListener: (
    event: "message",
    listener: (channel: string, message: string) => void,
  ) => unknown;
};

type RedisConnections = {
  publisher: RedisPublisher;
  subscriber: RedisSubscriber;
};

export type RedisEventEnvelope = {
  channel: string;
  event: string;
  data: string;
  excludeSocket?: string;
  ts: number;
  nodeId: string;
  userId?: string;
};

export class RedisEventAdapter implements EventAdapter {
  private readonly publisher: RedisPublisher;
  private readonly subscriber: RedisSubscriber;
  private readonly appIdByRedisChannel: ReadonlyMap<string, string>;
  private initialized = false;
  private closed = false;

  constructor(
    redisUrl: string,
    appIds: readonly string[],
    private readonly nodeId: string,
    private readonly local: Pick<EventAdapter, "receive">,
    private readonly logger: AdapterLogger,
    connections: RedisConnections = createRedisConnections(redisUrl),
  ) {
    this.publisher = connections.publisher;
    this.subscriber = connections.subscriber;
    this.appIdByRedisChannel = new Map(
      appIds.map((appId) => [redisEventChannel(appId), appId]),
    );

    this.publisher.on("error", (error) => {
      this.logger.error(
        { error: error.message, connection: "publisher" },
        "Redis event adapter connection error",
      );
    });
    this.subscriber.on("error", (error) => {
      this.logger.error(
        { error: error.message, connection: "subscriber" },
        "Redis event adapter connection error",
      );
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.closed) {
      throw new Error("Redis event adapter is closed");
    }

    try {
      await Promise.all([
        connectIfNeeded(this.publisher),
        connectIfNeeded(this.subscriber),
      ]);
      this.subscriber.on("message", this.handleMessage);
      await this.subscriber.subscribe(...this.appIdByRedisChannel.keys());
      this.initialized = true;
    } catch (error) {
      this.subscriber.removeListener("message", this.handleMessage);
      await closeConnections(this.publisher, this.subscriber);
      this.closed = true;
      throw new Error(
        `Unable to initialize Redis event adapter: ${formatError(error)}`,
      );
    }
  }

  async publish(event: EventPublish): Promise<boolean> {
    if (!this.initialized || this.closed) {
      throw new Error("Redis event adapter is not initialized");
    }

    const envelope: RedisEventEnvelope = {
      channel: event.channel,
      event: event.event,
      data: event.data,
      ...(event.excludeSocket === undefined
        ? {}
        : { excludeSocket: event.excludeSocket }),
      ts: Date.now(),
      nodeId: this.nodeId,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
    };

    try {
      const subscribers = await this.publisher.publish(
        redisEventChannel(event.appId),
        JSON.stringify(envelope),
      );
      return subscribers > 0;
    } catch (error) {
      this.logger.error(
        { error: formatError(error), appId: event.appId },
        "Redis event publish failed",
      );
      throw error;
    }
  }

  receive(event: EventPublish): boolean {
    return this.local.receive(event);
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ): Promise<unknown> {
    if (!this.initialized || this.closed) {
      throw new Error("Redis event adapter is not initialized");
    }
    return this.publisher.eval(script, numberOfKeys, ...arguments_);
  }

  async call(command: string, ...arguments_: string[]): Promise<unknown> {
    if (!this.initialized || this.closed) {
      throw new Error("Redis event adapter is not initialized");
    }
    return this.publisher.call(command, ...arguments_);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.subscriber.removeListener("message", this.handleMessage);

    if (this.initialized) {
      try {
        await this.subscriber.unsubscribe(...this.appIdByRedisChannel.keys());
      } catch (error) {
        this.logger.warn(
          { error: formatError(error) },
          "Unable to unsubscribe Redis event adapter cleanly",
        );
      }
    }

    await closeConnections(this.publisher, this.subscriber);
  }

  private readonly handleMessage = (
    redisChannel: string,
    rawEnvelope: string,
  ): void => {
    const appId = this.appIdByRedisChannel.get(redisChannel);
    const envelope = parseRedisEventEnvelope(rawEnvelope);
    if (!appId || !envelope) {
      this.logger.warn(
        { redisChannel },
        "Dropped malformed Redis event envelope",
      );
      return;
    }

    this.receive({
      appId,
      channel: envelope.channel,
      event: envelope.event,
      data: envelope.data,
      ...(envelope.excludeSocket === undefined
        ? {}
        : { excludeSocket: envelope.excludeSocket }),
      ...(envelope.userId === undefined ? {} : { userId: envelope.userId }),
    });
  };
}

export function redisEventChannel(appId: string): string {
  return `${EVENT_CHANNEL_PREFIX}${appId}`;
}

export function parseRedisEventEnvelope(
  rawEnvelope: string,
): RedisEventEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(rawEnvelope);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.channel !== "string" ||
    envelope.channel.length === 0 ||
    typeof envelope.event !== "string" ||
    envelope.event.length === 0 ||
    typeof envelope.data !== "string" ||
    typeof envelope.ts !== "number" ||
    !Number.isFinite(envelope.ts) ||
    typeof envelope.nodeId !== "string" ||
    envelope.nodeId.length === 0 ||
    (envelope.excludeSocket !== undefined &&
      typeof envelope.excludeSocket !== "string") ||
    (envelope.userId !== undefined && typeof envelope.userId !== "string")
  ) {
    return undefined;
  }

  return {
    channel: envelope.channel,
    event: envelope.event,
    data: envelope.data,
    ...(envelope.excludeSocket === undefined
      ? {}
      : { excludeSocket: envelope.excludeSocket }),
    ts: envelope.ts,
    nodeId: envelope.nodeId,
    ...(envelope.userId === undefined ? {} : { userId: envelope.userId }),
  };
}

function createRedisConnections(redisUrl: string): RedisConnections {
  const options = {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
  } as const;
  return {
    publisher: new Redis(redisUrl, options),
    subscriber: new Redis(redisUrl, options),
  };
}

async function connectIfNeeded(connection: RedisPublisher): Promise<void> {
  if (connection.status === "wait") {
    await connection.connect();
  }
}

async function closeConnections(
  publisher: RedisPublisher,
  subscriber: RedisSubscriber,
): Promise<void> {
  await Promise.all([closeConnection(publisher), closeConnection(subscriber)]);
}

async function closeConnection(connection: RedisPublisher): Promise<void> {
  if (connection.status === "end") {
    return;
  }
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
