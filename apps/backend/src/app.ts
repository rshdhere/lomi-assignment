import cors from "cors";
import express from "express";
import { api, errorResponse } from "@repo/api";
import { config } from "@repo/config";

export function createApp() {
  const app = express();
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
