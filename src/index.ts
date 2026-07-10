import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const config = await loadConfig();
  const server = await startServer(config);
  console.log(`PulseWS listening on port ${server.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
