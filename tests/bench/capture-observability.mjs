// Capture what an anonymous reviewer can actually see after a hosted load test.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium, expect } = createRequire(
  new URL("../../apps/frontend/package.json", import.meta.url),
)("@playwright/test");
const dir = process.argv[2] ?? "benchmark-results";
const read = (name) => readFileSync(join(dir, name), "utf8").trim();
const soak = existsSync(join(dir, "telemetry-after-soak.json"));
const report = JSON.parse(
  read(soak ? "telemetry-after-soak.json" : "telemetry.json"),
);
const run = soak
  ? JSON.parse(read("soak.jsonl").split("\n").at(-1))
  : JSON.parse(read("baseline.json"));
const from = Date.parse(run.startedAt) - 10_000;
// Include the final Collector export and Prometheus scrape in the baseline.
const to = Date.parse(report.verifiedAt) + 10_000;
assert.ok(Number.isFinite(from) && to > from, "Missing measured time window");
const url = new URL(report.dashboardPath, "http://127.0.0.1:13000");
url.search = new URLSearchParams({ from, to, refresh: "off", kiosk: "1" });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1860 },
  timezoneId: "UTC",
});
const diagnostics = { url: url.href, errors: [], queries: [] };
page.on("pageerror", (error) => diagnostics.errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") diagnostics.errors.push(message.text());
});
page.on("requestfailed", (req) =>
  diagnostics.errors.push(
    `${req.failure()?.errorText} ${req.url().split("?")[0]}`,
  ),
);
page.on("response", async (res) => {
  const path = new URL(res.url()).pathname;
  if (res.status() >= 400)
    diagnostics.errors.push(`HTTP ${res.status()} ${path}`);
  if (path !== "/api/ds/query") return;
  try {
    const queries = res.request().postDataJSON()?.queries ?? [];
    const { results } = await res.json();
    for (const query of queries) {
      const data = results?.[query.refId];
      diagnostics.queries.push({
        source: query.datasource?.uid,
        target: query.expr ?? query.service,
        error: data?.error,
        frames: data?.frames?.length ?? 0,
        samples: data?.frames?.[0]?.data?.values?.[0]?.length ?? 0,
      });
    }
  } catch (error) {
    diagnostics.errors.push(error.message);
  }
});

// Locate panel contents via Grafana's own e2e attributes.
const content = (name) =>
  page
    .getByTestId(`data-testid Panel header ${name}`)
    .getByTestId("data-testid panel content");
const timeout = 60_000;
try {
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  const viewer = await page.evaluate(() => {
    const user = window.grafanaBootData?.user;
    return { role: user?.orgRole, signedIn: user?.isSignedIn };
  });
  assert.deepEqual(viewer, { role: "Viewer", signedIn: false });
  const stat = content("API requests per second");
  const chart = content("Postgres extraction state");
  const logs = content("API and worker events");
  const traces = content("Recent extraction traces");
  // A taller initial viewport activates all 12 panels before we take the image.
  // Query success alone also occurs when a browser only renders panel headings.
  await Promise.all([
    expect(stat).toContainText(/\d/, { timeout }),
    expect(chart.locator("canvas").first()).toBeVisible({ timeout }),
    expect(chart).toContainText("Queued", { timeout }),
    expect(logs).toContainText(
      /HTTP request completed|Extraction attempt completed/i,
      { timeout },
    ),
    expect(traces).toContainText(/\b[\da-f]{16,32}\b|lomi-(?:api|worker)/i, {
      timeout,
    }),
    expect(traces).toBeInViewport({ timeout }),
  ]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, "grafana.png") });
  diagnostics.rendered = {
    viewer,
    statistic: (await stat.innerText()).trim(),
    chartLegend: (await chart.innerText()).trim(),
    logSample: (await logs.innerText()).trim().slice(0, 350),
    traceSample: (await traces.innerText()).trim().slice(0, 450),
  };
  writeFileSync(
    join(dir, "dashboard-render.json"),
    JSON.stringify(diagnostics, null, 2),
  );

  assert.match(report.traceID, /^[a-f0-9]{16,32}$/);
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto(`http://127.0.0.1:16686/trace/${report.traceID}`);
  await expect(
    page.getByText("extract version", { exact: true }).first(),
  ).toBeVisible({ timeout });
  await page.screenshot({ path: join(dir, "jaeger.png") });
} catch (error) {
  diagnostics.page = page.url();
  diagnostics.panels = await page
    .locator("section[data-testid]")
    .evaluateAll((panels) =>
      panels.map((panel) => ({
        panel: panel.dataset.testid,
        text: panel.innerText.slice(0, 400),
        canvases: panel.querySelectorAll("canvas").length,
        content: panel
          .querySelector('[data-testid="data-testid panel content"]')
          ?.innerHTML.slice(0, 350),
      })),
    );
  writeFileSync(
    join(dir, "capture-failure.json"),
    JSON.stringify(diagnostics, null, 2),
  );
  console.error(JSON.stringify(diagnostics));
  await page.screenshot({ path: join(dir, "capture-failure.png") });
  throw error;
} finally {
  await browser.close();
}
