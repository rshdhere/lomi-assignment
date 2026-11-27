import { httpTelemetry } from "@repo/common/telemetry";
import cors from "cors";
import express from "express";
import { api, errorResponse } from "@repo/api";
import { config } from "@repo/config";

export function createApp(telemetryEnabled = false) {
  const app = express();
  if (telemetryEnabled) {
    const startRequest = httpTelemetry();
    app.use((req, res, next) => {
      const request = startRequest(req.method);
      res.once("close", () => {
        // Express route templates omit document IDs, query strings and bodies.
        const route =
          typeof req.route?.path === "string" ? req.route.path : "unmatched";
        request.finish(route, res.statusCode, !res.writableFinished);
      });
      request.run(next);
    });
  }
  app.disable("x-powered-by");
  if (config.trustSingleProxy) app.set("trust proxy", 1);
  app.use(
    cors({
      origin: config.uiOrigin,
      exposedHeaders: ["Retry-After", "Location"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(api);
  app.use((_req, res) => {
    res.status(404).json({ message: "Route not found" });
  });
  app.use(errorResponse);
  return app;
}
