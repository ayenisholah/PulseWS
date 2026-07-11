import { readFile } from "node:fs/promises";

import { z } from "zod";

const appConfigSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    key: z.string().min(1, "key is required"),
    secret: z.string().min(1, "secret is required"),
    maxConnections: z
      .number()
      .int("maxConnections must be an integer")
      .positive("maxConnections must be positive"),
    maxClientEventsPerSecond: z
      .number()
      .int("maxClientEventsPerSecond must be an integer")
      .positive("maxClientEventsPerSecond must be positive"),
    maxRestPublishesPerSecond: z
      .number()
      .int("maxRestPublishesPerSecond must be an integer")
      .positive("maxRestPublishesPerSecond must be positive")
      .default(100),
  })
  .strict();

const demoConfigSchema = z
  .object({
    appKey: z.string().min(1, "appKey is required"),
    channel: z
      .string()
      .regex(
        /^presence-[A-Za-z0-9_\-=@,.;]+$/,
        "channel must be a valid presence channel",
      )
      .max(200, "channel must be 200 characters or fewer"),
  })
  .strict();

export const configSchema = z
  .object({
    port: z
      .number()
      .int("port must be an integer")
      .min(1, "port must be between 1 and 65535")
      .max(65535, "port must be between 1 and 65535"),
    redisUrl: z.string().url("redisUrl must be a valid URL").optional(),
    apps: z.array(appConfigSchema).min(1, "at least one app is required"),
    demo: demoConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.demo &&
      !config.apps.some((app) => app.key === config.demo?.appKey)
    ) {
      context.addIssue({
        code: "custom",
        path: ["demo", "appKey"],
        message: "appKey must match a configured application",
      });
    }
  });

export type AppConfig = z.infer<typeof appConfigSchema>;
export type PulseWsConfig = z.infer<typeof configSchema>;

export function parseConfig(input: unknown): PulseWsConfig {
  const result = configSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new Error(`Invalid PulseWS config: ${formatZodError(result.error)}`);
}

export async function loadConfig(
  path = process.env.PULSEWS_CONFIG ?? "pulsews.config.json",
): Promise<PulseWsConfig> {
  let rawConfig: string;
  try {
    rawConfig = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read PulseWS config at ${path}: ${formatError(error)}`);
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Invalid JSON in PulseWS config at ${path}: ${formatError(error)}`);
  }

  try {
    return parseConfig(parsedConfig);
  } catch (error) {
    throw new Error(`Invalid PulseWS config at ${path}: ${formatError(error)}`);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
