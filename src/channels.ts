export type ChannelType = "public" | "private" | "presence" | "encrypted";

export type ChannelValidationResult =
  | {
      ok: true;
      type: "public";
      channel: string;
    }
  | {
      ok: false;
      reason: string;
      type?: ChannelType;
    };

export function classifyChannelName(channel: string): ChannelType {
  if (channel.startsWith("private-encrypted-")) {
    return "encrypted";
  }

  if (channel.startsWith("private-")) {
    return "private";
  }

  if (channel.startsWith("presence-")) {
    return "presence";
  }

  return "public";
}

export function validatePublicChannelName(
  channel: unknown,
): ChannelValidationResult {
  if (typeof channel !== "string" || channel.length === 0) {
    return {
      ok: false,
      reason: "Channel name must be a non-empty string",
    };
  }

  if (channel.startsWith("#")) {
    return {
      ok: false,
      reason: "Channel name is invalid",
    };
  }

  const type = classifyChannelName(channel);
  if (type !== "public") {
    return {
      ok: false,
      type,
      reason: `${type} channels are not supported yet`,
    };
  }

  return {
    ok: true,
    type,
    channel,
  };
}

export function topicFor(appId: string, channel: string): string {
  return `${appId}/${channel}`;
}
