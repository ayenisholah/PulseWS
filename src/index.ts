import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const config = await loadConfig();
  const server = await startServer(config);
  console.log(`PulseWS listening on port ${server.port}`);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    shutdownPromise ??= server.close().then(
      () => {
        console.log(`PulseWS stopped after ${signal}`);
      },
      (error: unknown) => {
        console.error(
          "PulseWS graceful shutdown failed:",
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
