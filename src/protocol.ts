import { randomInt } from "node:crypto";

export const DEFAULT_ACTIVITY_TIMEOUT_SECONDS = 120;
export const APP_NOT_FOUND_CLOSE_CODE = 4001;
export const APP_NOT_FOUND_MESSAGE = "App key not found";

type PusherMessage = {
  event: string;
  data: string;
  channel?: string;
};

export type ClientMessage = {
  event: string;
  data?: unknown;
  channel?: string;
};

export function createSocketId(): string {
  return `${randomInt(1, 100_000)}.${randomInt(1, 100_000)}`;
}

export function encodePusherData(value: unknown): string {
  return JSON.stringify(value);
}

export function connectionEstablishedMessage(
  socketId: string,
  activityTimeout = DEFAULT_ACTIVITY_TIMEOUT_SECONDS,
): PusherMessage {
  return {
    event: "pusher:connection_established",
    data: encodePusherData({
      socket_id: socketId,
      activity_timeout: activityTimeout,
    }),
  };
}

export function errorMessage(code: number, message: string): PusherMessage {
  return {
    event: "pusher:error",
    data: encodePusherData({
      code,
      message,
    }),
  };
}

export function pongMessage(): PusherMessage {
  return {
    event: "pusher:pong",
    data: encodePusherData({}),
  };
}

export function decodeClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Message must be valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("event" in parsed) ||
    typeof parsed.event !== "string"
  ) {
    throw new Error("Message must include an event string");
  }

  const message = parsed as {
    event: string;
    data?: unknown;
    channel?: unknown;
  };

  return {
    event: message.event,
    data: message.data,
    ...(typeof message.channel === "string" ? { channel: message.channel } : {}),
  };
}

export function subscriptionSucceededMessage(channel: string): PusherMessage {
  return {
    event: "pusher_internal:subscription_succeeded",
    channel,
    data: encodePusherData({}),
  };
}

export function channelEventMessage(
  channel: string,
  event: string,
  data: unknown,
): PusherMessage {
  return channelEventMessageFromEncodedData(
    channel,
    event,
    encodePusherData(data),
  );
}

export function channelEventMessageFromEncodedData(
  channel: string,
  event: string,
  data: string,
): PusherMessage {
  return {
    event,
    channel,
    data,
  };
}

export function encodePusherMessage(message: PusherMessage): string {
  return JSON.stringify(message);
}
