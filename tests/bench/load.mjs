// Run in the cloud with the isolated Compose project documented in README.md.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import { setTimeout as pause } from "node:timers/promises";

const api = "http://127.0.0.1:14000";
const compose = [
  "compose",
  "-p",
  "lomi-bench",
  "-f",
  "compose.yaml",
  "-f",
  "tests/integration/compose.yaml",
];
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const config = {
  readers: 4,
  readWindowMs: 8000,
  readPaceMs: 150,
  invoices: 8,
  uploadConcurrency: 4,
  pollMs: 500,
  drainLimitMs: 180000,
  burst: 32,
};
const pdf = readFileSync("fixtures/documents/invoice-001.pdf");

function verifyStack() {
  const inspect = (name) => {
    const id = docker(...compose, "ps", "-q", name);
    assert.ok(id, `Start the lomi-bench ${name} service first`);
    return JSON.parse(docker("inspect", id))[0];
  };
  const backend = inspect("backend");
  const worker = inspect("worker");
  for (const service of [backend, worker]) {
    assert.ok(
      service.Config.Env.includes(
        "OPENAI_BASE_URL=http://model-double:4545/v1",
      ),
      "Expected the integration model double",
    );
    assert.ok(
      service.Config.Env.includes("OPENAI_API_KEY=test-only"),
      "Expected integration credentials",
    );
  }
  assert.equal(backend.Image, worker.Image, "API and worker images differ");
  assert.ok(
    backend.NetworkSettings.Ports["4000/tcp"].some(
      (p) => p.HostIp === "127.0.0.1" && p.HostPort === "14000",
    ),
  );
  const paths = git(
    "ls-files",
    "-co",
    "--exclude-standard",
    "--",
    "apps/backend",
    "apps/worker",
    "packages",
    "fixtures",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
  )
    .split("\n")
    .filter(existsSync);
  const local = paths.map((path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  );
  const remote = JSON.parse(
    execFileSync(
      "docker",
      [
        ...compose,
        "exec",
        "-T",
        "backend",
        "node",
        "-e",
        `
    const {readFileSync} = require("node:fs");
    const {createHash} = require("node:crypto");
    const paths = JSON.parse(readFileSync(0,"utf8"));
    process.stdout.write(JSON.stringify(paths.map(path => createHash("sha256").update(readFileSync(path)).digest("hex"))));
  `,
      ],
      { input: JSON.stringify(paths), encoding: "utf8" },
    ),
  );
  assert.ok(
    local.every((hash, index) => remote[index] === hash),
    "Rebuild the integration image from this checkout before benchmarking",
  );
  return {
    commit: git("rev-parse", "HEAD"),
    image: backend.Image,
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(paths.map((p, i) => [p, local[i]])))
      .digest("hex"),
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length
      ? Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 10) / 10
      : null;
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: percentile(1),
  };
}
const metrics = new Map();
const failures = [];
function startPhase(name) {
  metrics.set(name, {
    start: performance.now(),
    end: null,
    operations: new Map(),
  });
}
function endPhase(name) {
  metrics.get(name).end = performance.now();
}
function record(phase, op, status, duration) {
  const operations = metrics.get(phase).operations;
  if (!operations.has(op)) operations.set(op, { statuses: {}, ms: [] });
  const bucket = operations.get(op);
  bucket.statuses[status] = (bucket.statuses[status] ?? 0) + 1;
  bucket.ms.push(duration);
}
async function request(phase, op, path, init = {}) {
  const started = performance.now();
  let code = "transport_error";
  try {
    const res = await fetch(api + path, {
      ...init,
      signal: AbortSignal.timeout(12_000),
    });
    code = res.status;
    const data = await res.json();
    return { code, data, retryAfter: res.headers.get("Retry-After") };
  } finally {
    record(phase, op, code, performance.now() - started);
  }
}
async function pool(count, concurrency, run) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        const index = next++;
        try {
          await run(index);
        } catch (error) {
          failures.push(error.message);
        }
      }
    }),
  );
}
async function readWindow(phase) {
  const until = performance.now() + config.readWindowMs;
  await pool(config.readers, config.readers, async (lane) => {
    let turn = lane;
    while (performance.now() < until) {
      const list = turn++ % 2 === 0;
      const res = await request(
        phase,
        list ? "list" : "detail",
        list ? "/documents" : "/documents/doc-invoice-001",
      );
      assert.equal(res.code, 200);
      if (list) assert.ok(res.data.documents.length > 0);
      else assert.equal(res.data.id, "doc-invoice-001");
      await pause(config.readPaceMs);
    }
  });
}
const receipts = [];
const completion = [];
const outcomes = {};
async function enqueue(i) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([pdf], { type: "application/pdf" }),
    "load-invoice.pdf",
  );
  form.set("type", "invoice");
  form.set("title", `Load invoice ${i + 1}`);
  const start = performance.now();
  const res = await request("extraction", "upload", "/documents", {
    method: "POST",
    body: form,
  });
  assert.equal(
    res.code,
    202,
    "Invoice intake was rejected; start with a fresh quota window",
  );
  assert.ok(res.data.id);
  receipts.push({ id: res.data.id, start });
}
async function waitForDocument(index) {
  const { id, start } = receipts[index];
  let state = "timed_out";
  try {
    while (performance.now() - start < config.drainLimitMs) {
      const res = await request(
        "extraction",
        "status",
        "/documents/" + encodeURIComponent(id),
      );
      assert.equal(res.code, 200);
      if (res.data.status === "failed") {
        state = "failed";
        throw Error("Extraction failed for " + id);
      }
      if (res.data.status === "extracted") {
        assert.equal(res.data.values.length, 5);
        assert.ok(
          res.data.values.every(
            (v) => v.quote && res.data.parsedText.includes(v.quote),
          ),
        );
        state = "extracted";
        completion.push(performance.now() - start);
        return;
      }
      assert.ok(["queued", "extracting"].includes(res.data.status));
      await pause(config.pollMs);
    }
    throw Error("Extraction timed out for " + id);
  } catch (error) {
    if (state !== "failed" && performance.now() - start < config.drainLimitMs)
      state = "invalid_response";
    throw error;
  } finally {
    outcomes[state] = (outcomes[state] ?? 0) + 1;
  }
}
const retries = [];
async function waitForSeed() {
  const deadline = Date.now() + config.drainLimitMs;
  let last = "API starting";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(api + "/documents", {
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      const seeds =
        body.documents?.filter((d) =>
          ["doc-invoice-001", "doc-report-001", "doc-lease-001"].includes(d.id),
        ) ?? [];
      if (
        response.ok &&
        seeds.length === 3 &&
        seeds.every((d) => d.status === "extracted")
      )
        return;
      last =
        seeds.map((d) => d.id + ": " + d.status).join(", ") ||
        "seed documents unavailable";
    } catch (error) {
      last = error.message;
    }
    await pause(1000);
  }
  throw Error("Seed extraction did not finish: " + last);
}
async function run() {
  const revision = verifyStack();
  await waitForSeed();
  const startedAt = new Date().toISOString();
  startPhase("baseline");
  await readWindow("baseline");
  endPhase("baseline");

  startPhase("extraction");
  startPhase("concurrentReads");
  const reads = readWindow("concurrentReads").finally(() =>
    endPhase("concurrentReads"),
  );
  await pool(config.invoices, config.uploadConcurrency, enqueue);
  await pool(receipts.length, config.invoices, waitForDocument);
  endPhase("extraction");
  await reads;

  startPhase("burst");
  await pool(config.burst, 4, async (i) => {
    const res = await request("burst", "upload_manifest", "/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ name: `burst-${i}.pdf`, type: "invoice", size: pdf.length }],
      }),
    });
    if (res.code === 429) {
      const seconds = Number(res.retryAfter);
      assert.ok(
        Number.isInteger(seconds) && seconds >= 1 && seconds <= 60,
        "429 missing a valid retry window",
      );
      retries.push(seconds);
    } else {
      assert.equal(res.code, 201);
      assert.equal(res.data.uploads.length, 1);
    }
  });
  if (!retries.length) failures.push("The burst did not receive a 429");
  endPhase("burst");

  const phases = Object.fromEntries(
    [...metrics].map(([name, m]) => [
      name,
      {
        elapsedMs: Math.round(m.end - m.start),
        operations: Object.fromEntries(
          [...m.operations].map(([op, x]) => [
            op,
            { statuses: x.statuses, latencyMs: stats(x.ms) },
          ]),
        ),
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        startedAt,
        ...revision,
        cpu: cpus()[0]?.model,
        logicalCPUs: cpus().length,
        platform: platform(),
        node: process.version,
        config,
        phases,
        receipts: receipts.length,
        outcomes,
        uploadToExtractedMs: stats(completion),
        retryAfterSeconds: stats(retries),
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length) process.exitCode = 1;
}
await run();
