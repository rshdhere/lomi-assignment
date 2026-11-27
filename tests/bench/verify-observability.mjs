// Run after load.mjs on the isolated benchmark. All reads go through Grafana.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const grafana = "http://127.0.0.1:13000";
async function get(path, query) {
  const url = new URL(path, grafana);
  url.search = new URLSearchParams(query).toString();
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  assert.ok(res.ok, `${url.pathname} returned HTTP ${res.status}`);
  return res.json();
}

async function verify() {
  const { dashboard, meta } = await get("/api/dashboards/uid/lomi-load-live");
  assert.equal(dashboard.uid, "lomi-load-live");
  const base = "/api/datasources/proxy/uid/";
  const metrics = {};
  for (const metric of [
    "lomi_http_requests_total",
    "lomi_extraction_attempts_total",
    "lomi_queue_queued",
    "lomi_queue_oldest_queued_seconds",
  ]) {
    const { data } = await get(base + "prometheus/api/v1/query", {
      query: `sum(${metric})`,
    });
    assert.equal(data.result.length, 1, `Missing ${metric}`);
    const value = Number(data.result[0].value[1]);
    assert.ok(Number.isFinite(value) && value >= 0, metric);
    if (metric.endsWith("_total")) assert.ok(value > 0, metric);
    metrics[metric] = value;
  }
  const { data: traces } = await get(base + "jaeger/api/traces", {
    service: "lomi-worker",
    operation: "extract version",
    lookback: "15m",
    limit: "100",
  });
  const trace = traces.find((trace) => {
    const service = (span) => trace.processes[span.processID]?.serviceName;
    const apiSpans = new Set(
      trace.spans.filter((s) => service(s) === "lomi-api").map((s) => s.spanID),
    );
    return trace.spans.some(
      (s) =>
        service(s) === "lomi-worker" &&
        s.references.some((ref) => apiSpans.has(ref.spanID)),
    );
  });
  assert.ok(trace, "Missing connected upload and worker spans");
  const correlatedLogTimes = {};
  for (const service of ["lomi-api", "lomi-worker"]) {
    const { data } = await get(base + "loki/loki/api/v1/query_range", {
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
    firstPanel: dashboard.panels.find((panel) => panel.type !== "row").title,
    metrics,
    correlatedLogTimes,
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
