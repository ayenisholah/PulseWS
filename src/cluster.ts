import type { EventAdapter } from "./adapter/types.js";
import { encodePusherData } from "./protocol.js";
import {
  nodeSocketsKey,
  parseRedisNodeSocketRecord,
  presenceKey,
  type RedisNodeSocketRecord,
  RedisPresenceRegistry,
} from "./redis-presence.js";

const NODES_KEY = "pulsews:nodes";
const DEFAULT_HEARTBEAT_TTL_SECONDS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS = 10_000;
const DEFAULT_SWEEP_INTERVAL_MILLISECONDS = 10_000;

type RedisClusterCommands = {
  eval: (
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ) => Promise<unknown>;
  call: (command: string, ...arguments_: string[]) => Promise<unknown>;
};

type ClusterLogger = {
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
  drop?: (reason: string) => void;
};

export type ClusterTimingOptions = {
  heartbeatTtlSeconds?: number;
  heartbeatIntervalMilliseconds?: number;
  sweepIntervalMilliseconds?: number;
};

export interface ConnectionCoordinator {
  initialize(): Promise<void>;
  reserveConnection(
    appId: string,
    socketId: string,
    maximumConnections: number,
  ): Promise<boolean>;
  releaseConnection(appId: string, socketId: string): Promise<void>;
  close(): Promise<void>;
}

export class LocalConnectionCoordinator implements ConnectionCoordinator {
  private readonly counts = new Map<string, number>();
  private readonly appBySocket = new Map<string, string>();

  async initialize(): Promise<void> {}

  async reserveConnection(
    appId: string,
    socketId: string,
    maximumConnections: number,
  ): Promise<boolean> {
    const count = this.counts.get(appId) ?? 0;
    if (count >= maximumConnections) {
      return false;
    }
    this.counts.set(appId, count + 1);
    this.appBySocket.set(socketId, appId);
    return true;
  }

  async releaseConnection(appId: string, socketId: string): Promise<void> {
    if (this.appBySocket.get(socketId) !== appId) {
      return;
    }
    this.appBySocket.delete(socketId);
    const count = this.counts.get(appId) ?? 0;
    if (count <= 1) {
      this.counts.delete(appId);
    } else {
      this.counts.set(appId, count - 1);
    }
  }

  async close(): Promise<void> {}
}

const REGISTER_NODE_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;

const RESERVE_CONNECTION_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then
  return 0
end
if redis.call('SADD', KEYS[2], ARGV[2]) == 1 then
  redis.call('INCR', KEYS[1])
end
return 1
`;

const RELEASE_CONNECTION_SCRIPT = `
if redis.call('SREM', KEYS[2], ARGV[1]) == 0 then
  return 0
end
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
else
  redis.call('DECR', KEYS[1])
end
return 1
`;

const SWEEP_SOCKET_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {0}
end
if redis.call('SREM', KEYS[2], ARGV[1]) == 0 then
  return {1}
end

local removed = {}
for index = 4, #KEYS do
  local member_json = redis.call('HGET', KEYS[index], ARGV[2])
  if member_json then
    redis.call('HDEL', KEYS[index], ARGV[2])
    local leaving = cjson.decode(member_json)
    local remaining = redis.call('HVALS', KEYS[index])
    local last = 1
    for _, value in ipairs(remaining) do
      local member = cjson.decode(value)
      if member.user_id == leaving.user_id then
        last = 0
        break
      end
    end
    if redis.call('HLEN', KEYS[index]) == 0 then
      redis.call('DEL', KEYS[index])
    end
    if last == 1 then
      table.insert(removed, cjson.encode({
        channel = ARGV[index - 1],
        user_id = leaving.user_id
      }))
    end
  end
end

local current = tonumber(redis.call('GET', KEYS[3]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[3])
else
  redis.call('DECR', KEYS[3])
end

local result = {1}
for _, value in ipairs(removed) do
  table.insert(result, value)
end
return result
`;

const REMOVE_DEAD_NODE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`;

export class RedisClusterCoordinator implements ConnectionCoordinator {
  private readonly heartbeatTtlSeconds: number;
  private readonly heartbeatIntervalMilliseconds: number;
  private readonly sweepIntervalMilliseconds: number;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private closed = false;

  constructor(
    private readonly redis: RedisClusterCommands,
    private readonly presence: RedisPresenceRegistry,
    private readonly events: Pick<EventAdapter, "publish">,
    private readonly nodeId: string,
    private readonly logger: ClusterLogger,
    timing: ClusterTimingOptions = {},
  ) {
    this.heartbeatTtlSeconds =
      timing.heartbeatTtlSeconds ?? DEFAULT_HEARTBEAT_TTL_SECONDS;
    this.heartbeatIntervalMilliseconds =
      timing.heartbeatIntervalMilliseconds ??
      DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS;
    this.sweepIntervalMilliseconds =
      timing.sweepIntervalMilliseconds ?? DEFAULT_SWEEP_INTERVAL_MILLISECONDS;
  }

  async initialize(): Promise<void> {
    await this.redis.eval(
      REGISTER_NODE_SCRIPT,
      2,
      NODES_KEY,
      heartbeatKey(this.nodeId),
      this.nodeId,
      String(this.heartbeatTtlSeconds),
    );
    this.heartbeatTimer = setInterval(() => {
      void this.refreshHeartbeat().catch((error: unknown) => {
        this.logger.drop?.("redis_connection_failure");
        this.logger.error(
          { error: formatError(error), nodeId: this.nodeId },
          "Redis node heartbeat failed",
        );
      });
    }, this.heartbeatIntervalMilliseconds);
    this.heartbeatTimer.unref();

    this.sweepTimer = setInterval(() => {
      void this.sweepDeadNodes();
    }, this.sweepIntervalMilliseconds);
    this.sweepTimer.unref();
  }

  async reserveConnection(
    appId: string,
    socketId: string,
    maximumConnections: number,
  ): Promise<boolean> {
    const record = this.presence.registerSocket(appId, socketId);
    const result = await this.redis.eval(
      RESERVE_CONNECTION_SCRIPT,
      2,
      connectionCountKey(appId),
      nodeSocketsKey(this.nodeId),
      String(maximumConnections),
      record,
    );
    if (result !== 1) {
      this.presence.forgetSocket(socketId);
      return false;
    }
    return true;
  }

  async releaseConnection(appId: string, socketId: string): Promise<void> {
    const record = this.presence.currentSocketRecord(socketId);
    if (!record) {
      return;
    }
    await this.redis.eval(
      RELEASE_CONNECTION_SCRIPT,
      2,
      connectionCountKey(appId),
      nodeSocketsKey(this.nodeId),
      record,
    );
    this.presence.forgetSocket(socketId);
  }

  async sweepDeadNodes(): Promise<void> {
    if (this.sweeping || this.closed) {
      return;
    }
    this.sweeping = true;
    try {
      const nodes = readStringArray(await this.redis.call("SMEMBERS", NODES_KEY));
      for (const nodeId of nodes) {
        if (nodeId === this.nodeId) {
          continue;
        }
        const heartbeatExists = await this.redis.call(
          "EXISTS",
          heartbeatKey(nodeId),
        );
        if (heartbeatExists === 0) {
          await this.sweepNode(nodeId);
        }
      }
    } catch (error) {
      this.logger.drop?.("cluster_cleanup_failure");
      this.logger.error(
        { error: formatError(error), nodeId: this.nodeId },
        "Redis dead-node sweep failed",
      );
    } finally {
      this.sweeping = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  private async refreshHeartbeat(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.redis.call(
      "SET",
      heartbeatKey(this.nodeId),
      this.nodeId,
      "EX",
      String(this.heartbeatTtlSeconds),
    );
  }

  private async sweepNode(nodeId: string): Promise<void> {
    const socketsKey = nodeSocketsKey(nodeId);
    const rawRecords = readStringArray(
      await this.redis.call("SMEMBERS", socketsKey),
    );
    for (const rawRecord of rawRecords) {
      const record = parseRedisNodeSocketRecord(rawRecord);
      if (!record) {
        this.logger.warn(
          { nodeId },
          "Dropped malformed Redis node socket record",
        );
        this.logger.drop?.("malformed_node_socket_record");
        await this.redis.call("SREM", socketsKey, rawRecord);
        continue;
      }
      const removals = await this.sweepSocket(nodeId, rawRecord, record);
      for (const removal of removals) {
        await this.events.publish({
          appId: record.app_id,
          channel: removal.channel,
          event: "pusher_internal:member_removed",
          data: encodePusherData({ user_id: removal.userId }),
        });
      }
    }

    await this.redis.eval(
      REMOVE_DEAD_NODE_SCRIPT,
      3,
      heartbeatKey(nodeId),
      socketsKey,
      NODES_KEY,
      nodeId,
    );
  }

  private async sweepSocket(
    nodeId: string,
    rawRecord: string,
    record: RedisNodeSocketRecord,
  ): Promise<Array<{ channel: string; userId: string }>> {
    const presenceKeys = record.presence_channels.map((channel) =>
      presenceKey(record.app_id, channel),
    );
    const result = await this.redis.eval(
      SWEEP_SOCKET_SCRIPT,
      3 + presenceKeys.length,
      heartbeatKey(nodeId),
      nodeSocketsKey(nodeId),
      connectionCountKey(record.app_id),
      ...presenceKeys,
      rawRecord,
      record.socket_id,
      ...record.presence_channels,
    );
    const values = readUnknownArray(result);
    if (values[0] !== 1) {
      return [];
    }
    return values.slice(1).map((value) => parseRemoval(value));
  }
}

export function heartbeatKey(nodeId: string): string {
  return `pulsews:node:${nodeId}:heartbeat`;
}

export function connectionCountKey(appId: string): string {
  return `pulsews:app:${appId}:connections`;
}

function parseRemoval(value: unknown): { channel: string; userId: string } {
  if (typeof value !== "string") {
    throw new Error("Redis dead-node sweep returned an invalid removal");
  }
  const parsed = JSON.parse(value) as { channel?: unknown; user_id?: unknown };
  if (typeof parsed.channel !== "string" || typeof parsed.user_id !== "string") {
    throw new Error("Redis dead-node sweep returned malformed removal data");
  }
  return { channel: parsed.channel, userId: parsed.user_id };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Redis command returned a non-string array");
  }
  return value as string[];
}

function readUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Redis script returned a non-array result");
  }
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
