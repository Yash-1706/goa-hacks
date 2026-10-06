import "./silence";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { log } from "./log";

const cfg = loadConfig();
const { start, stop } = await createApp(cfg);
await start();

let closing = false;
const shutdown = async (sig: string): Promise<void> => {
  if (closing) return;
  closing = true;
  log.info("server", `${sig}: shutting down`);
  try {
    await stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (r) => log.error("server", `unhandled rejection: ${(r as Error)?.message ?? r}`));
