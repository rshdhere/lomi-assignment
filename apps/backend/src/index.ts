import { config } from "@repo/config";
import { createApp } from "./app.ts";
const server = createApp().listen(config.port, "0.0.0.0", () => {
  console.log(`Lomi API listening on ${config.port}`);
});
process.once("SIGTERM", () => server.close());
