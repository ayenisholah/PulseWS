import { describe, expect, test } from "vitest";

import packageJsonData from "../package.json" with { type: "json" };

type PackageJson = {
  name: string;
  private: boolean;
  type: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const packageJson = packageJsonData as PackageJson;

describe("TypeScript project scaffold", () => {
  test("uses ESM and wires verify to typecheck plus tests", () => {
    expect(packageJson).toMatchObject({
      name: "pulsews",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
        verify: "npm run typecheck && npm run test",
      },
    });
  });

  test("keeps dependencies within the W1D1-1 allowlist", () => {
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      "pino",
      "uWebSockets.js",
      "zod",
    ]);
    expect(Object.keys(packageJson.devDependencies).sort()).toEqual([
      "pusher",
      "pusher-js",
      "tsx",
      "typescript",
      "vitest",
    ]);
  });
});
