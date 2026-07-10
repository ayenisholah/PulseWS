import { isValidChannelName } from "./channels.js";

export const MAX_INGRESS_BYTES = 10_240;
export const MAX_EVENT_NAME_LENGTH = 200;
export const MAX_PUBLISH_CHANNELS = 100;

const SOCKET_ID_PATTERN = /^\d+\.\d+$/;

export type PublishRequest = {
  name: string;
  channels: string[];
  data: string;
  socketId?: string;
};

export function parsePublishRequest(rawBody: Buffer): PublishRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Publish body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Publish body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  if (
    typeof body.name !== "string" ||
    body.name.length === 0 ||
    body.name.length > MAX_EVENT_NAME_LENGTH
  ) {
    throw new Error("Event name is invalid");
  }

  if (
    !Array.isArray(body.channels) ||
    body.channels.length === 0 ||
    body.channels.length > MAX_PUBLISH_CHANNELS ||
    !body.channels.every(isValidChannelName)
  ) {
    throw new Error("Channels are invalid");
  }

  if (typeof body.data !== "string") {
    throw new Error("Event data must be a string");
  }

  if (
    body.socket_id !== undefined &&
    (typeof body.socket_id !== "string" ||
      !SOCKET_ID_PATTERN.test(body.socket_id))
  ) {
    throw new Error("Socket id is invalid");
  }

  return {
    name: body.name,
    channels: body.channels,
    data: body.data,
    ...(body.socket_id === undefined ? {} : { socketId: body.socket_id }),
  };
}
