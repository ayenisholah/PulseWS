import type {
  PresenceJoinResult,
  PresenceLeaveResult,
  PresenceMember,
  PresenceRegistry,
  PresenceRoster,
  PresenceUserInfo,
} from "./presence.js";

type RedisScriptExecutor = {
  eval: (
    script: string,
    numberOfKeys: number,
    ...arguments_: string[]
  ) => Promise<unknown>;
};

type StoredPresenceMember = {
  user_id: string;
  user_info: PresenceUserInfo;
  node_id: string;
};

const JOIN_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
local joining = cjson.decode(ARGV[2])
if existing then
  local current = cjson.decode(existing)
  if current.user_id ~= joining.user_id then
    return {0, 'A socket cannot change presence identity while subscribed'}
  end
end

local values = redis.call('HVALS', KEYS[1])
local member_added = 1
for _, value in ipairs(values) do
  local member = cjson.decode(value)
  if member.user_id == joining.user_id then
    member_added = 0
    break
  end
end

if not existing then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
end

local roster = redis.call('HVALS', KEYS[1])
local result = {1, member_added}
for _, value in ipairs(roster) do
  table.insert(result, value)
end
return result
`;

const LEAVE_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if not existing then
  return {0}
end

redis.call('HDEL', KEYS[1], ARGV[1])
local leaving = cjson.decode(existing)
local values = redis.call('HVALS', KEYS[1])
for _, value in ipairs(values) do
  local member = cjson.decode(value)
  if member.user_id == leaving.user_id then
    return {0}
  end
end

if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end
return {1, existing}
`;

export class RedisPresenceRegistry implements PresenceRegistry {
  constructor(
    private readonly redis: RedisScriptExecutor,
    private readonly nodeId: string,
  ) {}

  async join(
    appId: string,
    channel: string,
    socketId: string,
    member: PresenceMember,
  ): Promise<PresenceJoinResult> {
    const stored: StoredPresenceMember = {
      user_id: member.userId,
      user_info: member.userInfo,
      node_id: this.nodeId,
    };
    const rawResult = await this.redis.eval(
      JOIN_SCRIPT,
      1,
      presenceKey(appId, channel),
      socketId,
      JSON.stringify(stored),
    );
    const result = readScriptArray(rawResult, "join");
    if (result[0] === 0) {
      return {
        ok: false,
        reason:
          typeof result[1] === "string"
            ? result[1]
            : "Redis presence join was rejected",
      };
    }
    if (result[0] !== 1 || (result[1] !== 0 && result[1] !== 1)) {
      throw new Error("Redis presence join returned an invalid result");
    }

    return {
      ok: true,
      memberAdded: result[1] === 1,
      roster: createRoster(result.slice(2)),
    };
  }

  async leave(
    appId: string,
    channel: string,
    socketId: string,
  ): Promise<PresenceLeaveResult> {
    const rawResult = await this.redis.eval(
      LEAVE_SCRIPT,
      1,
      presenceKey(appId, channel),
      socketId,
    );
    const result = readScriptArray(rawResult, "leave");
    if (result[0] === 0) {
      return { memberRemoved: false };
    }
    if (result[0] !== 1 || typeof result[1] !== "string") {
      throw new Error("Redis presence leave returned an invalid result");
    }
    const stored = parseStoredMember(result[1]);
    return {
      memberRemoved: true,
      member: { userId: stored.user_id, userInfo: stored.user_info },
    };
  }
}

export function presenceKey(appId: string, channel: string): string {
  return `pulsews:presence:${appId}:${channel}`;
}

function createRoster(rawMembers: unknown[]): PresenceRoster {
  const users = new Map<string, PresenceUserInfo>();
  for (const rawMember of rawMembers) {
    if (typeof rawMember !== "string") {
      throw new Error("Redis presence roster contained a non-string member");
    }
    const member = parseStoredMember(rawMember);
    if (!users.has(member.user_id)) {
      users.set(member.user_id, member.user_info);
    }
  }

  return {
    presence: {
      ids: [...users.keys()],
      hash: Object.fromEntries(users),
      count: users.size,
    },
  };
}

function parseStoredMember(rawMember: string): StoredPresenceMember {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMember);
  } catch {
    throw new Error("Redis presence member contained invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Redis presence member must be an object");
  }

  const member = parsed as Record<string, unknown>;
  if (
    typeof member.user_id !== "string" ||
    member.user_id.length === 0 ||
    typeof member.node_id !== "string" ||
    member.node_id.length === 0 ||
    typeof member.user_info !== "object" ||
    member.user_info === null ||
    Array.isArray(member.user_info)
  ) {
    throw new Error("Redis presence member has an invalid shape");
  }
  return {
    user_id: member.user_id,
    user_info: member.user_info as PresenceUserInfo,
    node_id: member.node_id,
  };
}

function readScriptArray(rawResult: unknown, operation: string): unknown[] {
  if (!Array.isArray(rawResult)) {
    throw new Error(`Redis presence ${operation} returned a non-array result`);
  }
  return rawResult;
}
