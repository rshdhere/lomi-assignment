// Run after load.mjs on the isolated benchmark. All reads go through Grafana.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const grafana = "http://127.0.0.1:13000";
async function request(path, query, init) {
  const url = new URL(path, grafana);
  url.search = new URLSearchParams(query).toString();
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  assert.ok(res.ok, `${url.pathname} returned HTTP ${res.status}`);
  return res.json();
}

async function verify() {
  const { dashboard, meta } = await request(
    "/api/dashboards/uid/lomi-load-live",
  );
  assert.equal(dashboard.uid, "lomi-load-live");
  const base = "/api/datasources/proxy/uid/";
  const metrics = {};
  for (const metric of [
    "lomi_http_requests_total",
    "lomi_extraction_attempts_total",
    "lomi_queue_queued",
    "lomi_queue_oldest_queued_seconds",
  ]) {
    const { data } = await request(base + "prometheus/api/v1/query", {
      query: `sum(${metric})`,
    });
    assert.equal(data.result.length, 1, `Missing ${metric}`);
    const value = Number(data.result[0].value[1]);
    assert.ok(Number.isFinite(value) && value >= 0, metric);
    if (metric.endsWith("_total")) assert.ok(value > 0, metric);
    metrics[metric] = value;
  }
  const target = dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .find((q) => q.datasource?.uid === "jaeger" && q.queryType === "search");
  assert.ok(target, "Missing Jaeger search panel");
  const now = Date.now();
  const { results } = await request(
    "/api/ds/query",
    {},
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: String(now - 15 * 60_000),
        to: String(now),
        queries: [target],
      }),
    },
  );
  const search = results[target.refId];
  assert.ok(
    search && !search.error,
    search?.error ?? "Missing Jaeger query result",
  );
  const traceIDs = search.frames.flatMap((frame) => {
    const field = frame.schema.fields.findIndex((f) => f.name === "traceID");
    return field < 0 ? [] : frame.data.values[field];
  });
  assert.ok(traceIDs.length, "Jaeger search panel returned no traces");
  let trace;
  for (const id of traceIDs) {
    assert.match(id, /^[a-f0-9]{16,32}$/);
    const {
      data: [candidate],
    } = await request(base + "jaeger/api/traces/" + id);
    if (!candidate) continue;
    const service = (span) => candidate.processes[span.processID]?.serviceName;
    const publishingRoutes = [
      "POST /documents",
      "POST /documents/:id/versions",
      "POST /uploads/:batchId/complete",
    ];
    const apiSpans = new Set(
      candidate.spans
        .filter(
          (s) =>
            service(s) === "lomi-api" &&
            publishingRoutes.includes(s.operationName),
        )
        .map((s) => s.spanID),
    );
    if (
      candidate.spans.some(
        (s) =>
          service(s) === "lomi-worker" &&
          s.operationName === "extract version" &&
          s.references.some(
            (ref) => ref.refType === "CHILD_OF" && apiSpans.has(ref.spanID),
          ),
      )
    ) {
      trace = candidate;
      break;
    }
  }
  assert.ok(trace, "Missing connected upload and worker spans");
  const correlatedLogTimes = {};
  for (const service of ["lomi-api", "lomi-worker"]) {
    const { data } = await request(base + "loki/loki/api/v1/query_range", {
      query: `{service_name="${service}"} | trace_id = "${trace.traceID}"`,
      limit: "1",
      since: "15m",
    });
    correlatedLogTimes[service] = data.result.flatMap((stream) =>
      stream.values.map(([ts]) => ts),
    );
    assert.ok(
      data.result.some((s) => s.values?.length),
      `Missing logs for ${service}`,
    );
  }
  return {
    dashboard: dashboard.uid,
    dashboardPath: meta.url,
    verifiedAt: new Date().toISOString(),
    metrics,
    correlatedLogTimes,
    jaegerPanelRows: traceIDs.length,
    spans: trace.spans.map((s) => ({
      service: trace.processes[s.processID]?.serviceName,
      operation: s.operationName,
      spanID: s.spanID,
      parents: s.references.map((ref) => ref.spanID),
      startMicros: s.startTime,
      durationMicros: s.duration,
    })),
    traceID: trace.traceID,
  };
}

const deadline = Date.now() + 120_000;
while (true) {
  try {
    console.log(JSON.stringify(await verify()));
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    await sleep(3_000);
  }
}
