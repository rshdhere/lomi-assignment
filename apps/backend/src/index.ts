import { startTelemetry } from "@repo/common/telemetry";
import { config } from "@repo/config";
import { createApp } from "./app.ts";
const telemetry = await startTelemetry("lomi-api");
const server = createApp(Boolean(telemetry)).listen(
  config.port,
  "0.0.0.0",
  () => {
    console.log(`Lomi API listening on ${config.port}`);
  },
);
process.once("SIGTERM", () => server.close(() => void telemetry?.shutdown()));
