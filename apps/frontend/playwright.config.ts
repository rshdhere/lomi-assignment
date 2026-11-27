import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 360_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1360, height: 960 },
  },
  outputDir: ".next/playwright-results",
});
