export type PresenceUserInfo = Record<string, unknown>;

export type PresenceMember = {
  userId: string;
  userInfo: PresenceUserInfo;
};

export type PresenceRoster = {
  presence: {
    ids: string[];
    hash: Record<string, PresenceUserInfo>;
    count: number;
  };
};

type PresenceUser = PresenceMember & {
  socketIds: Set<string>;
};

type PresenceChannel = {
  users: Map<string, PresenceUser>;
  usersBySocket: Map<string, string>;
};

export type PresenceJoinResult =
  | {
      ok: true;
      memberAdded: boolean;
      roster: PresenceRoster;
    }
  | {
      ok: false;
      reason: string;
    };

export type PresenceLeaveResult = {
  memberRemoved: boolean;
  member?: PresenceMember;
};

export class LocalPresenceRegistry {
  private readonly apps = new Map<string, Map<string, PresenceChannel>>();

  join(
    appId: string,
    channel: string,
    socketId: string,
    member: PresenceMember,
  ): PresenceJoinResult {
    const channelState = this.getOrCreateChannel(appId, channel);
    const existingUserId = channelState.usersBySocket.get(socketId);
    if (existingUserId && existingUserId !== member.userId) {
      return {
        ok: false,
        reason: "A socket cannot change presence identity while subscribed",
      };
    }

    if (existingUserId === member.userId) {
      return {
        ok: true,
        memberAdded: false,
        roster: createRoster(channelState),
      };
    }

    let user = channelState.users.get(member.userId);
    const memberAdded = user === undefined;
    if (!user) {
      user = { ...member, socketIds: new Set<string>() };
      channelState.users.set(member.userId, user);
    }

    user.socketIds.add(socketId);
    channelState.usersBySocket.set(socketId, member.userId);
    return { ok: true, memberAdded, roster: createRoster(channelState) };
  }

  leave(appId: string, channel: string, socketId: string): PresenceLeaveResult {
    const channels = this.apps.get(appId);
    const channelState = channels?.get(channel);
    const userId = channelState?.usersBySocket.get(socketId);
    if (!channels || !channelState || !userId) {
      return { memberRemoved: false };
    }

    channelState.usersBySocket.delete(socketId);
    const user = channelState.users.get(userId);
    if (!user) {
      return { memberRemoved: false };
    }

    user.socketIds.delete(socketId);
    if (user.socketIds.size > 0) {
      return { memberRemoved: false };
    }

    channelState.users.delete(userId);
    if (channelState.users.size === 0) {
      channels.delete(channel);
      if (channels.size === 0) {
        this.apps.delete(appId);
      }
    }

    return {
      memberRemoved: true,
      member: { userId: user.userId, userInfo: user.userInfo },
    };
  }

  private getOrCreateChannel(appId: string, channel: string): PresenceChannel {
    let channels = this.apps.get(appId);
    if (!channels) {
      channels = new Map();
      this.apps.set(appId, channels);
    }

    let channelState = channels.get(channel);
    if (!channelState) {
      channelState = { users: new Map(), usersBySocket: new Map() };
      channels.set(channel, channelState);
    }
    return channelState;
  }
}

export function parsePresenceChannelData(raw: unknown): PresenceMember {
  if (typeof raw !== "string") {
    throw new Error("Presence channel_data must be a JSON string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Presence channel_data must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Presence channel_data must be a JSON object");
  }

  const data = parsed as { user_id?: unknown; user_info?: unknown };
  if (typeof data.user_id !== "string" || data.user_id.length === 0) {
    throw new Error("Presence user_id must be a non-empty string");
  }
  if (
    data.user_info !== undefined &&
    (typeof data.user_info !== "object" ||
      data.user_info === null ||
      Array.isArray(data.user_info))
  ) {
    throw new Error("Presence user_info must be a JSON object");
  }

  return {
    userId: data.user_id,
    userInfo: (data.user_info as PresenceUserInfo | undefined) ?? {},
  };
}

function createRoster(channel: PresenceChannel): PresenceRoster {
  const users = [...channel.users.values()];
  return {
    presence: {
      ids: users.map((user) => user.userId),
      hash: Object.fromEntries(
        users.map((user) => [user.userId, user.userInfo]),
      ),
      count: users.length,
    },
  };
}
