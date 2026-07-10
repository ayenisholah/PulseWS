import { randomInt } from "node:crypto";

export const DEFAULT_ACTIVITY_TIMEOUT_SECONDS = 120;
export const APP_NOT_FOUND_CLOSE_CODE = 4001;
export const APP_NOT_FOUND_MESSAGE = "App key not found";

type PusherMessage = {
  event: string;
  data: string;
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

export function encodePusherMessage(message: PusherMessage): string {
  return JSON.stringify(message);
}
