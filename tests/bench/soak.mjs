// Run on the disposable lomi-bench project; stdout is newline-delimited JSON.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const api = "http://127.0.0.1:14000";
const storage = "http://localhost:19000";
const project = "lomi-bench";
const pdf = readFileSync("fixtures/documents/invoice-001.pdf");
const blob = new Blob([pdf], { type: "application/pdf" });
const runId = randomUUID();
const seconds = integer("SOAK_SECONDS", 3600, 120, 7200);
const maxConcurrency = integer("SOAK_CONCURRENCY", 16, 4, 32);
const schedule = [
  { name: "warm", minutes: 10, readsPerSecond: 4, flowsPerMinute: 2 },
  { name: "steady", minutes: 15, readsPerSecond: 20, flowsPerMinute: 8 },
  { name: "peak", minutes: 20, readsPerSecond: 60, flowsPerMinute: 16 },
  { name: "cooldown", minutes: 10, readsPerSecond: 12, flowsPerMinute: 5 },
  { name: "drain", minutes: 5, readsPerSecond: 0, flowsPerMinute: 0 },
];
const emit = (event, data) =>
  console.log(
    JSON.stringify({ event, at: new Date().toISOString(), runId, ...data }),
  );
function integer(name, defaultValue, min, max) {
  const value = Number(process.env[name] ?? defaultValue);
  assert(
    Number.isInteger(value) && value >= min && value <= max,
    `${name} must be ${min}..${max}`,
  );
  return value;
}
function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 10000,
  }).trim();
}
function verifyStack() {
  const ids = docker(
    "compose",
    "-p",
    project,
    "-f",
    "compose.yaml",
    "-f",
    "tests/integration/compose.yaml",
    "ps",
    "--status",
    "running",
    "-q",
  );
  assert(ids, "Start the isolated lomi-bench stack first");
  const services = {};
  for (const c of JSON.parse(docker("inspect", ...ids.split(/\s+/)))) {
    assert.equal(c.Config.Labels["com.docker.compose.project"], project);
    if (c.Config.Labels["com.docker.compose.service"] === "pdf-parser") {
      assert.equal(c.HostConfig.NetworkMode, "none");
      assert(c.HostConfig.ReadonlyRootfs);
      continue;
    }
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [
      project + "_default",
    ]);
    const name = c.Config.Labels["com.docker.compose.service"];
    assert(!services[name], "Expected one container per service");
    services[name] = c;
  }
  for (const s of [
    "redis",
    "backend",
    "worker",
    "postgres",
    "storage",
    "model-double",
  ])
    assert(services[s], s);
  assert.equal(services.backend.Image, services.worker.Image);
  for (const c of [services.backend, services.worker]) {
    for (const env of [
      "OPENAI_BASE_URL=http://model-double:4545/v1",
      "OPENAI_API_KEY=test-only",
      "S3_ENDPOINT=http://storage:9000",
      "REDIS_URL=redis://redis:6379",
      "DATABASE_URL=postgres://review:review@postgres:5432/review",
    ])
      assert(
        c.Config.Env.includes(env),
        "Unexpected backend or worker configuration",
      );
  }
  assert(services.backend.Config.Env.includes("S3_PUBLIC_ENDPOINT=" + storage));
  for (const [c, port, host] of [
    [services.backend, 4000, 14000],
    [services.storage, 9000, 19000],
  ]) {
    assert.deepEqual(c.NetworkSettings.Ports[port + "/tcp"], [
      { HostIp: "127.0.0.1", HostPort: String(host) },
    ]);
  }
  for (const [service, volume] of [
    ["postgres", "pgdata"],
    ["storage", "pdfs"],
  ])
    assert(
      services[service].Mounts.some(
        (m) => m.Type === "volume" && m.Name === project + "_" + volume,
      ),
    );
  return {
    image: services.backend.Image,
    redisId: services.redis.Id,
    containers: Object.fromEntries(
      Object.entries(services).map(([k, c]) => [k, c.Id]),
    ),
  };
}
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p) =>
    sorted.length
      ? Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10
      : null;
  return {
    n: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: q(1),
  };
}
const measurements = Object.fromEntries(
  schedule.map(({ name }) => [
    name,
    {
      operations: {},
      dropped: {},
      completionMs: [],
      maxQueued: 0,
      maxActive: 0,
      redisMaxWaiting: 0,
      redisMaxActive: 0,
    },
  ]),
);
const receipts = new Map(),
  pendingBatches = new Map();
const inflight = new Set(),
  busy = new Set();
const errorExamples = [];
let errorCount = 0,
  throttles = 0,
  burstThrottles = 0,
  issued = 0,
  peakInflight = 0,
  maxPending = 0;
let readTurn = 0,
  queryTurn = 0,
  reviewedId,
  stopAt = Infinity;
const processStart = performance.now();
const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const waitHint = [];
const sampleEveryMs = 30000;
const pollEveryMs = 5000;
function failure(op, error) {
  errorCount++;
  if (errorExamples.length < 30)
    errorExamples.push({
      op,
      message: String(error.message ?? error).slice(0, 240),
    });
}
async function request(phase, op, url, init, codes, jsonBody = true) {
  const begin = performance.now();
  if (begin >= stopAt) throw Error("Window closed during " + op);
  const metric = (measurements[phase].operations[op] ??= {
    statuses: {},
    times: [],
  });
  let status = "transport_error";
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    status = res.status;
    const text = await res.text();
    if (res.status === 429 && codes.includes(429)) {
      const retry = Number(res.headers.get("retry-after"));
      assert(
        Number.isInteger(retry) && retry >= 1 && retry <= 60,
        "Invalid Retry-After",
      );
      waitHint.push(retry);
      throttles++;
      if (op === "burstUpload") burstThrottles++;
      return { retry };
    }
    assert(codes.includes(res.status), `${op} returned HTTP ${res.status}`);
    return { data: jsonBody ? JSON.parse(text) : null };
  } finally {
    metric.statuses[status] = (metric.statuses[status] ?? 0) + 1;
    metric.times.push(performance.now() - begin);
  }
}
function launch(phase, name, fn, exclusive = false) {
  if ((exclusive && busy.has(name)) || inflight.size >= maxConcurrency) {
    const dropped = measurements[phase].dropped;
    dropped[name] = (dropped[name] ?? 0) + 1;
    return false;
  }
  if (exclusive) busy.add(name);
  const task = Promise.resolve()
    .then(fn)
    .catch((e) => failure(name, e))
    .finally(() => {
      inflight.delete(task);
      if (exclusive) busy.delete(name);
    });
  inflight.add(task);
  peakInflight = Math.max(peakInflight, inflight.size);
  return true;
}
function accept(phase, doc, began) {
  assert(typeof doc.id === "string" && doc.version === 1);
  assert(!receipts.has(doc.id), "Duplicate receipt ID");
  receipts.set(doc.id, {
    id: doc.id,
    began,
    phase,
    status: "queued",
    evidence: false,
    reviewed: false,
  });
}
async function multipart(phase, burst = false) {
  const began = performance.now();
  const data = new FormData();
  data.set("file", blob, "soak-invoice.pdf");
  data.set("type", "invoice");
  data.set("title", `Soak ${runId} ${++issued}`);
  const result = await request(
    phase,
    burst ? "burstUpload" : "multipartUpload",
    api + "/documents",
    { method: "POST", body: data },
    [202, 429],
  );
  if (!result.retry) accept(phase, result.data, began);
}
async function complete(phase, batch) {
  const result = await request(
    phase,
    "completeBatch",
    api + "/uploads/" + encodeURIComponent(batch.id) + "/complete",
    json({}),
    [202, 429],
  );
  if (result.retry) {
    batch.due = performance.now() + result.retry * 1000;
    return;
  }
  assert.equal(result.data.documents.length, batch.size);
  for (const doc of result.data.documents) accept(phase, doc, batch.began);
  pendingBatches.delete(batch.id);
}
async function signed(phase) {
  const began = performance.now();
  const files = Array.from({ length: phase === "peak" ? 8 : 2 }, (_, i) => ({
    name: `soak-${runId}-${++issued}-${i}.pdf`,
    type: "invoice",
    size: pdf.length,
  }));
  const manifest = await request(
    phase,
    "createBatch",
    api + "/uploads",
    json({ files }),
    [201, 429],
  );
  if (manifest.retry) return;
  assert.equal(manifest.data.uploads.length, files.length);
  for (const target of manifest.data.uploads) {
    assert.equal(
      new URL(target.url).origin,
      storage,
      "Presigned target outside test storage",
    );
    const form = new FormData();
    for (const [key, value] of Object.entries(target.fields))
      form.set(key, value);
    form.set("file", blob, "soak-invoice.pdf");
    await request(
      phase,
      "storageUpload",
      target.url,
      { method: "POST", body: form },
      [200, 201, 204],
      false,
    );
  }
  const batch = {
    id: manifest.data.batchId,
    size: files.length,
    began,
    due: 0,
  };
  pendingBatches.set(batch.id, batch);
  // The single retry lane owns completions, including 429 retries.
}
async function read(phase) {
  const list = readTurn++ % 2 === 0;
  const result = await request(
    phase,
    list ? "list" : "seedDetail",
    api + (list ? "/documents" : "/documents/doc-invoice-001"),
    {},
    [200],
  );
  if (list) assert(Array.isArray(result.data.documents));
  else assert.equal(result.data.id, "doc-invoice-001");
}
async function query(phase) {
  if (!reviewedId) return;
  const id = reviewedId;
  const lexical = queryTurn++ % 2 === 0;
  const result = await request(
    phase,
    lexical ? "lexicalQuery" : "semanticQuery",
    api + "/query",
    json({
      documentId: id,
      question: lexical
        ? "What is the exact vendor name?"
        : "Who supplied the goods?",
    }),
    [200, 429],
  );
  if (result.retry) return;
  assert.equal(result.data.mode, lexical ? "lexical" : "semantic");
  assert.equal(result.data.answer, "Meridian Office Supplies");
  assert(
    result.data.sources.some(
      (s) => s.reviewed && s.documentId === id && s.version === 1,
    ),
  );
}
async function refresh(phase) {
  const list = await request(
    phase,
    "pollLibrary",
    api + "/documents",
    {},
    [200],
  );
  const byId = new Map(list.data.documents.map((d) => [d.id, d]));
  let queued = 0,
    active = 0;
  for (const item of receipts.values()) {
    const doc = byId.get(item.id);
    // Concurrent receipts can arrive between this list's snapshot and response.
    if (!doc || item.status === "extracted" || item.status === "failed")
      continue;
    assert(
      ["extracted", "failed", "queued", "extracting"].includes(doc.status),
      "Invalid document status",
    );
    item.status = doc.status;
    if (doc.status === "extracted")
      measurements[item.phase].completionMs.push(
        performance.now() - item.began,
      );
    if (doc.status === "failed")
      failure("extraction", Error("Extraction failed for " + item.id));
  }
  for (const item of receipts.values()) {
    if (item.status === "queued") queued++;
    if (item.status === "extracting") active++;
  }
  measurements[phase].maxQueued = Math.max(
    measurements[phase].maxQueued,
    queued,
  );
  measurements[phase].maxActive = Math.max(
    measurements[phase].maxActive,
    active,
  );
  maxPending = Math.max(maxPending, queued + active);
  const found = [...receipts.values()].filter(
    (i) => i.status === "extracted" && !i.reviewed,
  );
  for (const item of found.slice(0, 4)) {
    if (!item.evidence) {
      const { data } = await request(
        phase,
        "verifyInvoice",
        api + "/documents/" + encodeURIComponent(item.id),
        {},
        [200],
      );
      assert.equal(data.id, item.id);
      assert.equal(data.version, 1);
      assert.equal(data.values.length, 5);
      assert.equal(new Set(data.values.map((v) => v.field)).size, 5);
      assert(
        data.values.every(
          (v) => v.value && v.quote && data.parsedText.includes(v.quote),
        ),
        "Invalid invoice evidence",
      );
      item.fieldId = data.values.find((v) => v.field === "vendor_name").id;
      item.evidence = true;
    }
    const r = await request(
      phase,
      "reviewVendor",
      api + "/values/" + encodeURIComponent(item.fieldId) + "/review",
      json({
        action: "correct",
        value: "Meridian Office Supplies",
        note: "Isolated soak check",
      }),
      [200, 429],
    );
    if (r.retry) break;
    assert(r.data.saved);
    item.reviewed = true;
    reviewedId = item.id;
  }
}
function outcomes() {
  const counts = {
    queued: 0,
    extracting: 0,
    extracted: 0,
    failed: 0,
    evidenceChecked: 0,
    reviewed: 0,
    receipts: receipts.size,
    pendingBatches: pendingBatches.size,
  };
  for (const i of receipts.values()) {
    counts[i.status]++;
    if (i.evidence) counts.evidenceChecked++;
    if (i.reviewed) counts.reviewed++;
  }
  return counts;
}
function phaseReport(p) {
  const m = measurements[p];
  return {
    operations: Object.fromEntries(
      Object.entries(m.operations).map(([op, v]) => [
        op,
        { statuses: v.statuses, latencyMs: stats(v.times) },
      ]),
    ),
    skippedSchedules: m.dropped,
    observedCompletionMs: stats(m.completionMs),
    maxQueued: m.maxQueued,
    maxActive: m.maxActive,
    redisMaxWaiting: m.redisMaxWaiting,
    redisMaxActive: m.redisMaxActive,
  };
}
let lastQueue = null;
async function queueSample(phase, stack) {
  const lua =
    "return {redis.call('llen','bull:extraction:wait'),redis.call('llen','bull:extraction:active'),redis.call('zcard','bull:extraction:delayed'),redis.call('zcard','bull:extraction:failed')}";
  const { stdout } = await exec(
    "docker",
    ["exec", stack.redisId, "redis-cli", "--raw", "EVAL", lua, "0"],
    { timeout: 5000 },
  );
  const values = stdout.trim().split(/\s+/).map(Number);
  assert(
    values.length === 4 &&
      values.every((x) => Number.isSafeInteger(x) && x >= 0),
    "Bad Redis metrics",
  );
  const [waiting, active, delayed, failed] = values;
  lastQueue = { waiting, active, delayed, failed };
  measurements[phase].redisMaxWaiting = Math.max(
    measurements[phase].redisMaxWaiting,
    waiting,
  );
  measurements[phase].redisMaxActive = Math.max(
    measurements[phase].redisMaxActive,
    active,
  );
}
const stack = verifyStack();
const readiness = await fetch(api + "/documents", {
  redirect: "error",
  signal: AbortSignal.timeout(10000),
});
assert.equal(readiness.status, 200);
const seeds = (await readiness.json()).documents;
for (const id of ["doc-invoice-001", "doc-report-001", "doc-lease-001"]) {
  assert(
    seeds.some((d) => d.id === id && d.status === "extracted"),
    "Wait for all three seeds to extract before the soak",
  );
}
const first = performance.now(),
  startedAt = new Date().toISOString();
stopAt = first + seconds * 1000;
const phases = schedule.map((p, i) => ({
  ...p,
  endsAt:
    first +
    (seconds *
      1000 *
      schedule.slice(0, i + 1).reduce((n, q) => n + q.minutes, 0)) /
      60,
}));
emit("soak-start", {
  startedAt,
  seconds,
  maxConcurrency,
  schedule,
  pollEveryMs,
  sampleEveryMs,
  image: stack.image,
  containers: stack.containers,
  git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  harnessSha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  cpu: cpus()[0]?.model,
  availableCPUs: availableParallelism(),
  node: process.version,
  model: "integration-double",
  setupMs: Math.round(first - processStart),
});
let index = -1,
  nextRead = 0,
  nextFlow = 0,
  nextPoll = 0,
  nextQuery = 0,
  nextSample = 0,
  nextCompletion = 0;
let flow = 0,
  nextBurst = Infinity,
  burstDue = 0;
while (performance.now() < stopAt) {
  const now = performance.now();
  const i = phases.findIndex((p) => now < p.endsAt);
  if (i < 0) break;
  const p = phases[i],
    phase = p.name;
  if (i !== index) {
    if (index >= 0)
      emit("phase-end", {
        phase: phases[index].name,
        outcomes: outcomes(),
        metrics: phaseReport(phases[index].name),
      });
    index = i;
    nextRead = now;
    nextFlow = now;
    nextQuery = now;
    nextSample = now;
    nextBurst = phase === "peak" ? now : Infinity;
    burstDue = 0;
    emit("phase-start", {
      phase,
      elapsedSeconds: Math.round((now - first) / 1000),
    });
  }
  // Leave the last 12 seconds free for previously dispatched I/O to settle.
  if (now < stopAt - 12000) {
    if (now >= nextPoll) {
      launch(phase, "poll", () => refresh(phase), true);
      nextPoll = now + pollEveryMs;
    }
    if (now >= nextSample) {
      launch(
        phase,
        "queueSample",
        async () => {
          await queueSample(phase, stack);
          emit("sample", {
            phase,
            elapsedSeconds: Math.round((performance.now() - first) / 1000),
            outcomes: outcomes(),
            redis: lastQueue,
            errors: errorCount,
            inflight: inflight.size,
            metrics: phaseReport(phase),
          });
        },
        true,
      );
      nextSample = now + sampleEveryMs;
    }
    if (now >= nextCompletion) {
      const batch = [...pendingBatches.values()].find((b) => now >= b.due);
      if (batch) launch(phase, "complete", () => complete(phase, batch), true);
      nextCompletion = now + 500;
    }
    if (p.readsPerSecond && now >= nextRead) {
      const interval = 1000 / p.readsPerSecond;
      const due = 1 + Math.floor((now - nextRead) / interval);
      nextRead += due * interval;
      // Account for delayed schedules without a catch-up flood after a slow response.
      const dispatch = Math.min(due, maxConcurrency);
      for (let r = 0; r < dispatch; r++)
        launch(phase, "read", () => read(phase));
      const skipped = measurements[phase].dropped;
      skipped.read = (skipped.read ?? 0) + due - dispatch;
    }
    if (p.flowsPerMinute && now >= nextFlow) {
      launch(phase, "flow", () =>
        ++flow % 4 === 0 ? signed(phase) : multipart(phase),
      );
      nextFlow = now + 60000 / p.flowsPerMinute;
    }
    if (p.readsPerSecond && now >= nextQuery && reviewedId) {
      launch(phase, "query", () => query(phase), true);
      nextQuery = now + 15000;
    }
    if (now >= nextBurst) {
      burstDue += 32;
      nextBurst = Infinity;
    }
    while (burstDue > 0 && inflight.size < maxConcurrency - 2) {
      launch(phase, "burst", () => multipart(phase, true));
      burstDue--;
    }
  }
  await sleep(Math.min(50, Math.max(1, stopAt - performance.now())));
}
await Promise.allSettled([...inflight]);
const windowElapsedMs = performance.now() - first;
const totals = outcomes();
const backlog = totals.queued + totals.extracting;
if (
  totals.receipts === 0 ||
  totals.evidenceChecked !== totals.receipts ||
  totals.reviewed !== totals.receipts ||
  backlog ||
  totals.failed ||
  totals.pendingBatches
)
  failure(
    "outcomes",
    Error("Accepted work or evidence/review verification did not fully drain"),
  );
if (!burstThrottles) failure("burst", Error("No validated burst Retry-After"));
const ops = Object.values(measurements).map((m) => m.operations);
for (const [name, status] of [
  ["storageUpload", 204],
  ["completeBatch", 202],
  ["lexicalQuery", 200],
  ["semanticQuery", 200],
]) {
  const ok = ops.some((p) =>
    name === "storageUpload"
      ? [200, 201, 204].some((s) => p[name]?.statuses[s])
      : p[name]?.statuses[status],
  );
  if (!ok) failure("coverage", Error("No successful " + name));
}
emit("soak-result", {
  startedAt,
  requestedSeconds: seconds,
  windowElapsedMs: Math.round(windowElapsedMs),
  fullHour: windowElapsedMs >= 3600000,
  peakInflight,
  maxPending,
  remainingBacklog: backlog,
  outcomes: totals,
  lastSampledRedis: lastQueue,
  rateLimitedResponses: throttles,
  burstThrottles,
  retryAfterSeconds: stats(waitHint),
  phases: Object.fromEntries(phases.map((p) => [p.name, phaseReport(p.name)])),
  errorCount,
  errorExamples,
  pass: errorCount === 0,
});
if (errorCount) process.exitCode = 1;
