import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  currentTraceparent,
  extractionTelemetry,
  extractionStage,
  httpTelemetry,
  observeQueue,
  startTelemetry,
} from "../src/telemetry.ts";

test("opt-in telemetry exports bounded signals and reconnects a durable upload parent", async (t) => {
  // Tests in this process send all three signals to the local receiver.
  for (const name of Object.keys(process.env))
    if (name.startsWith("OTEL_")) delete process.env[name];
  assert.equal(await startTelemetry("lomi-api"), undefined);
  const signals = new Map<string, string>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    signals.set(req.url!, body);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  const sdk = await startTelemetry("lomi-api");
  assert(sdk);
  const upload = httpTelemetry()("POST");
  let parent: string | undefined;
  upload.run(() => {
    parent = currentTraceparent();
  });
  assert.match(parent!, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  upload.finish("/documents", 202, false);
  assert.equal(currentTraceparent(), undefined);
  const stages = [
    "read pinned PDF",
    "parse PDF",
    "extract and enrich",
    "commit extraction",
  ] as const;
  await extractionTelemetry()(parent, async () => {
    for (const stage of stages) await extractionStage(stage, async () => true);
    return "extracted";
  });
  observeQueue(async () => ({
    queued: 2,
    extracting: 1,
    expiredClaims: 0,
    oldestQueuedSeconds: 3,
  }));
  await sdk.shutdown();
  const spans = JSON.parse(signals.get("/v1/traces")!).resourceSpans[0]
    .scopeSpans[0].spans;
  const uploadSpan = spans.find(
    (span: { name: string }) => span.name === "POST /documents",
  );
  const workerSpan = spans.find(
    (span: { name: string }) => span.name === "extract version",
  );
  for (const stage of stages) {
    const child = spans.find((span: { name: string }) => span.name === stage);
    assert.equal(child.parentSpanId, workerSpan.spanId);
    assert.equal(child.traceId, uploadSpan.traceId);
  }
  assert.equal(workerSpan.traceId, uploadSpan.traceId);
  assert.equal(workerSpan.parentSpanId, uploadSpan.spanId);
  const records = JSON.parse(signals.get("/v1/logs")!).resourceLogs[0]
    .scopeLogs[0].logRecords;
  assert.deepEqual(
    records.map((r: { body: { stringValue: string } }) => r.body.stringValue),
    ["HTTP request completed", "Extraction attempt completed"],
  );
  assert.equal(records[1].traceId, workerSpan.traceId);
  const exported = JSON.parse(signals.get("/v1/metrics")!).resourceMetrics[0]
    .scopeMetrics[0].metrics;
  assert.deepEqual(exported.map((m: { name: string }) => m.name).sort(), [
    "lomi.extraction.attempts",
    "lomi.extraction.duration",
    "lomi.http.request.duration",
    "lomi.http.requests",
    "lomi.queue.expired_claims",
    "lomi.queue.extracting",
    "lomi.queue.oldest_queued",
    "lomi.queue.queued",
  ]);
});
