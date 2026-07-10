import { describe, expect, test } from "vitest";

import {
  connectionEstablishedMessage,
  createSocketId,
  errorMessage,
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
});
