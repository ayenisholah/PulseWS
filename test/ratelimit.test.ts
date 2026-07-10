import { describe, expect, test } from "vitest";

import { TokenBucket } from "../src/ratelimit.js";

describe("token bucket", () => {
  test("starts with one second of capacity and rejects when empty", () => {
    let now = 0;
    const bucket = new TokenBucket(3, () => now);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("refills fractionally at the configured rate", () => {
    let now = 0;
    const bucket = new TokenBucket(2, () => now);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    now = 499;
    expect(bucket.tryConsume()).toBe(false);
    now = 500;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  test("clamps refills to one second of burst capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(2, () => now);

    expect(bucket.tryConsume()).toBe(true);
    now = 10_000;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });
});
