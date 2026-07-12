import { describe, expect, test } from "vitest";

import packageJsonData from "../package.json" with { type: "json" };

type PackageJson = {
  name: string;
  private: boolean;
  homepage: string;
  packageManager: string;
  author: { name: string; email: string; url: string };
  keywords: string[];
  type: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const packageJson = packageJsonData as PackageJson;

describe("TypeScript project scaffold", () => {
  test("uses ESM and wires verify to build, lint, and tests", () => {
    expect(packageJson).toMatchObject({
      name: "pulsews",
      private: true,
      type: "module",
      scripts: {
        build: "tsc -p tsconfig.build.json",
        lint: "tsc --noEmit",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        verify: "npm run build && npm run lint && npm run test",
      },
    });
  });

  test("keeps dependencies within the approved allowlist", () => {
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      "ioredis",
      "pino",
      "prom-client",
      "uWebSockets.js",
      "zod",
    ]);
    expect(Object.keys(packageJson.devDependencies).sort()).toEqual([
      "@types/node",
      "pusher",
      "pusher-js",
      "tsx",
      "typescript",
      "vitest",
    ]);
  });

  test("publishes complete project metadata without enabling npm publication", () => {
    expect(packageJson).toMatchObject({
      private: true,
      homepage: "https://pulsews.sholaayeni.xyz",
      packageManager: "npm@11.13.0",
      author: {
        name: "Shola Ayeni",
        email: "ayenisholah@yahoo.com",
        url: "https://github.com/ayenisholah",
      },
    });
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining([
        "pusher-compatible",
        "redis",
        "self-hosted",
        "typescript",
        "websocket-server",
      ]),
    );
  });
});
