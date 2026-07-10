import { describe, expect, test } from "vitest";

import {
  LimitedBodyBuffer,
  MAX_INGRESS_BYTES,
  parsePublishRequest,
} from "../src/publish.js";

describe("publish request parsing", () => {
  test("accepts SDK-shaped payloads and preserves pre-encoded data", () => {
    const data = JSON.stringify({ nested: { ok: true } });

    expect(
      parsePublishRequest(
        body({
          name: "demo.event",
          channels: ["public-updates", "private_room-=@,.;"],
          data,
          socket_id: "123.456",
        }),
      ),
    ).toEqual({
      name: "demo.event",
      channels: ["public-updates", "private_room-=@,.;"],
      data,
      socketId: "123.456",
    });
  });

  test("mirrors the official SDK event and channel boundaries", () => {
    expect(() =>
      parsePublishRequest(
        body({ name: "x".repeat(200), channels: ["c".repeat(200)], data: "{}" }),
      ),
    ).not.toThrow();
    expect(() =>
      parsePublishRequest(
        body({ name: "x".repeat(201), channels: ["valid"], data: "{}" }),
      ),
    ).toThrow("Event name");
    expect(() =>
      parsePublishRequest(
        body({ name: "valid", channels: ["c".repeat(201)], data: "{}" }),
      ),
    ).toThrow("Channels");
    expect(() =>
      parsePublishRequest(
        body({ name: "valid", channels: ["invalid channel"], data: "{}" }),
      ),
    ).toThrow("Channels");
  });

  test("requires a non-empty event, 1-100 channels, string data, and valid socket id", () => {
    const valid = { name: "event", channels: ["channel"], data: "{}" };
    const invalidBodies = [
      { ...valid, name: "" },
      { ...valid, channels: [] },
      { ...valid, channels: Array.from({ length: 101 }, (_, index) => `${index}`) },
      { ...valid, data: {} },
      { ...valid, socket_id: "not-a-socket" },
    ];

    for (const invalidBody of invalidBodies) {
      expect(() => parsePublishRequest(body(invalidBody))).toThrow();
    }
  });

  test("rejects malformed JSON and non-object bodies", () => {
    expect(() => parsePublishRequest(Buffer.from("not json"))).toThrow(
      "valid JSON",
    );
    expect(() => parsePublishRequest(Buffer.from("[]"))).toThrow("JSON object");
  });
});

describe("limited REST body buffering", () => {
  test("retains exactly 10 KB and rejects one byte more", () => {
    const exact = new LimitedBodyBuffer();
    expect(exact.append(new ArrayBuffer(MAX_INGRESS_BYTES))).toBe(true);
    expect(exact.toBuffer()).toHaveLength(MAX_INGRESS_BYTES);

    const oversized = new LimitedBodyBuffer();
    expect(oversized.append(new ArrayBuffer(MAX_INGRESS_BYTES))).toBe(true);
    expect(oversized.append(new ArrayBuffer(1))).toBe(false);
    expect(oversized.toBuffer()).toHaveLength(MAX_INGRESS_BYTES);
  });
});

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}
