import { describe, expect, test } from "vitest";

import { packageName } from "../src/version.js";

describe("project scaffold", () => {
  test("exposes the package name", () => {
    expect(packageName).toBe("pulsews");
  });
});
