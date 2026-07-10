import { describe, expect, test } from "vitest";

import {
  channelEventMessage,
  connectionEstablishedMessage,
  createSocketId,
  decodeClientMessage,
  errorMessage,
  pongMessage,
  subscriptionSucceededMessage,
} from "../src/protocol.js";

describe("pusher protocol helpers", () => {
  test("creates Pusher-style socket ids", () => {
    expect(createSocketId()).toMatch(/^\d+\.\d+$/);
  });

  test("encodes connection data as a JSON string", () => {
    const message = connectionEstablishedMessage("1234.5678", 120);

    expect(message).toEqual({
      event: "pusher:connection_established",
      data: expect.any(String),
    });
    expect(JSON.parse(message.data)).toEqual({
      socket_id: "1234.5678",
      activity_timeout: 120,
    });
  });

  test("encodes error data as a JSON string", () => {
    const message = errorMessage(4001, "App key not found");

    expect(message).toEqual({
      event: "pusher:error",
      data: expect.any(String),
    });
    expect(JSON.parse(message.data)).toEqual({
      code: 4001,
      message: "App key not found",
    });
  });

  test("encodes pong data as a JSON string", () => {
    expect(pongMessage()).toEqual({
      event: "pusher:pong",
      data: "{}",
    });
  });

  test("decodes inbound JSON client messages", () => {
    expect(
      decodeClientMessage(
        JSON.stringify({
          event: "pusher:subscribe",
          data: { channel: "updates" },
        }),
      ),
    ).toEqual({
      event: "pusher:subscribe",
      data: { channel: "updates" },
    });
  });

  test("rejects malformed inbound client messages", () => {
    expect(() => decodeClientMessage("not json")).toThrow("valid JSON");
    expect(() => decodeClientMessage(JSON.stringify({ data: {} }))).toThrow(
      "event string",
    );
  });

  test("encodes subscription success data as a JSON string", () => {
    const message = subscriptionSucceededMessage("updates");

    expect(message).toEqual({
      event: "pusher_internal:subscription_succeeded",
      channel: "updates",
      data: expect.any(String),
    });
    expect(JSON.parse(message.data)).toEqual({});
  });

  test("encodes channel event data as a JSON string", () => {
    const message = channelEventMessage("updates", "demo.event", { ok: true });

    expect(message).toEqual({
      event: "demo.event",
      channel: "updates",
      data: expect.any(String),
    });
    expect(JSON.parse(message.data)).toEqual({ ok: true });
  });
});
