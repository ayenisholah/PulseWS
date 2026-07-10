export type ChannelType = "public" | "private" | "presence" | "encrypted";

export const MAX_CHANNEL_NAME_LENGTH = 200;

const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9_\-=@,.;]+$/;

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
  if (!isValidChannelName(channel)) {
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

export function isValidChannelName(channel: unknown): channel is string {
  return (
    typeof channel === "string" &&
    channel.length <= MAX_CHANNEL_NAME_LENGTH &&
    CHANNEL_NAME_PATTERN.test(channel)
  );
}

export function topicFor(appId: string, channel: string): string {
  return `${appId}/${channel}`;
}
