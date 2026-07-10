import { describe, expect, test } from "vitest";

import {
  classifyChannelName,
  topicFor,
  validatePublicChannelName,
  validateSubscribableChannelName,
} from "../src/channels.js";

describe("channel helpers", () => {
  test("accepts public channel names", () => {
    expect(validatePublicChannelName("updates")).toEqual({
      ok: true,
      type: "public",
      channel: "updates",
    });
  });

  test("rejects names starting with # to match pusher-js behavior", () => {
    expect(validatePublicChannelName("#bad")).toMatchObject({
      ok: false,
    });
  });

  test("classifies private, presence, and encrypted channel names", () => {
    expect(classifyChannelName("private-room")).toBe("private");
    expect(classifyChannelName("presence-room")).toBe("presence");
    expect(classifyChannelName("private-encrypted-room")).toBe("encrypted");
  });

  test("rejects non-public channel types until their planned tasks", () => {
    expect(validatePublicChannelName("private-room")).toMatchObject({
      ok: false,
      type: "private",
    });
    expect(validatePublicChannelName("presence-room")).toMatchObject({
      ok: false,
      type: "presence",
    });
    expect(validatePublicChannelName("private-encrypted-room")).toMatchObject({
      ok: false,
      type: "encrypted",
    });
  });

  test("accepts private subscriptions while keeping presence and encrypted unsupported", () => {
    expect(validateSubscribableChannelName("private-room")).toEqual({
      ok: true,
      type: "private",
      channel: "private-room",
    });
    expect(validateSubscribableChannelName("presence-room")).toMatchObject({
      ok: false,
      type: "presence",
    });
    expect(
      validateSubscribableChannelName("private-encrypted-room"),
    ).toMatchObject({
      ok: false,
      type: "encrypted",
    });
  });

  test("builds app-scoped uWS topics", () => {
    expect(topicFor("app-1", "updates")).toBe("app-1/updates");
  });
});
