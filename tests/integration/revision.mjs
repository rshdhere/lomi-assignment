// With --recovery this also interrupts the worker and clears the dedicated test Redis.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const api = "http://127.0.0.1:14000";
const recovery = process.argv.includes("--recovery");
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const compose = (...args) =>
  docker(
    "compose",
    "-p",
    "lomi-check",
    "-f",
    "compose.yaml",
    "-f",
    "tests/integration/compose.yaml",
    ...args,
  );

function isolatedStack() {
  const ids = compose("ps", "--status", "running", "-q").split(/\s+/);
  const containers = JSON.parse(docker("inspect", ...ids));
  const services = {};
  for (const c of containers) {
    const labels = c.Config.Labels;
    const name = labels["com.docker.compose.service"];
    assert.equal(labels["com.docker.compose.project"], "lomi-check");
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [
      "lomi-check_default",
    ]);
    assert(
      [
        "backend",
        "worker",
        "redis",
        "postgres",
        "storage",
        "model-double",
        "frontend",
      ].includes(name),
    );
    assert(!services[name], `Unexpected replica of ${name}`);
    services[name] = c;
  }
  for (const name of [
    "backend",
    "worker",
    "redis",
    "postgres",
    "storage",
    "model-double",
  ]) {
    assert(services[name], `Missing running integration service: ${name}`);
  }
  for (const c of [services.backend, services.worker]) {
    for (const setting of [
      "OPENAI_API_KEY=test-only",
      "OPENAI_BASE_URL=http://model-double:4545/v1",
      "DATABASE_URL=postgres://review:review@postgres:5432/review",
      "REDIS_URL=redis://redis:6379",
      "S3_ENDPOINT=http://storage:9000",
    ])
      assert(
        c.Config.Env.includes(setting),
        "Unexpected integration service configuration",
      );
  }
  assert.equal(services.backend.Image, services.worker.Image);
  assert.deepEqual(services.backend.NetworkSettings.Ports["4000/tcp"], [
    { HostIp: "127.0.0.1", HostPort: "14000" },
  ]);
  assert(
    !Object.values(services.redis.NetworkSettings.Ports).some(
      (ports) => ports?.length,
    ),
  );
  for (const [service, path, name] of [
    [services.postgres, "/var/lib/postgresql/data", "lomi-check_pgdata"],
    [services.storage, "/bitnami/minio/data", "lomi-check_pdfs"],
  ]) {
    assert(
      service.Mounts.some(
        (m) => m.Destination === path && m.Type === "volume" && m.Name === name,
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(services).map(([name, c]) => [name, c.Id]),
  );
}

async function waitForLibrary() {
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await request("/documents", {
        signal: AbortSignal.timeout(3000),
      });
      assert(Array.isArray(result.documents));
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error("Library did not recover after the stack restart", {
    cause: lastError,
  });
}
const postJson = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
async function request(path, init, expected = 200) {
  const res = await fetch(api + path, init);
  const body = await res.json();
  assert.equal(res.status, expected, path + " " + JSON.stringify(body));
  return body;
}
async function until(path, predicate) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const doc = await request(path);
    if (predicate(doc)) return doc;
    assert.notEqual(doc.status, "failed", doc.error);
    await delay(250);
  }
  throw Error("Timed out waiting for " + path);
}
const invoice = await readFile("fixtures/documents/invoice-001.pdf");
const revised = await readFile("fixtures/documents/invoice-001.v2.pdf");
const stack = recovery ? isolatedStack() : null;
function pdfUpload(bytes) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([bytes], { type: "application/pdf" }),
    "invoice.pdf",
  );
  form.set("type", "invoice");
  return { method: "POST", body: form };
}
const uploadKey = randomUUID();
const keyedPdf = (bytes) => ({
  ...pdfUpload(bytes),
  headers: { "Idempotency-Key": uploadKey },
});
const [receipt, replayed] = await Promise.all([
  request("/documents", keyedPdf(invoice), 202),
  request("/documents", keyedPdf(invoice), 202),
]);
assert.deepEqual(receipt, replayed);
await request("/documents", keyedPdf(revised), 409);
const path = "/documents/" + receipt.id;
const conflict = await request(path + "/versions", pdfUpload(revised), 409);
assert.match(conflict.message, /after the current extraction finishes/i);
const first = await until(path, (d) => d.status === "extracted");
assert.equal(first.values.length, 5);
for (const item of first.values) {
  assert.ok(
    item.value && item.quote && first.parsedText.includes(item.quote),
    item.field,
  );
  const review =
    item.field === "vendor_name"
      ? {
          action: "correct",
          value: "Meridian Office Supplies",
          note: "Preferred capitalization",
        }
      : { action: "approve" };
  await request("/values/" + item.id + "/review", postJson(review));
}
const reviewed = await request(path + "?version=1");
assert.deepEqual(reviewed.progress, {
  approved: 4,
  corrected: 1,
  pending: 0,
  carriedOver: 0,
});
await request(path + "/versions", pdfUpload(revised), 202);
let interruptedAt;
let keysBeforeFlush;
if (recovery) {
  await until(path, (d) => d.version === 2 && d.status === "extracting");
  interruptedAt = Date.now();
  docker("kill", "--signal=SIGKILL", stack.worker);
  try {
    // Explicitly stop the worker to suppress its restart policy during the flush.
    docker("stop", "-t", "0", stack.worker);
    assert.equal(
      docker("inspect", "--format", "{{.State.Running}}", stack.worker),
      "false",
    );
    const interrupted = await request(path);
    assert.equal(interrupted.version, 2);
    assert.equal(interrupted.status, "extracting");
    const redis = (...args) =>
      docker("exec", stack.redis, "redis-cli", "--raw", ...args);
    keysBeforeFlush = Number(redis("DBSIZE"));
    assert(
      keysBeforeFlush > 0,
      "Redis must contain queue state before the flush",
    );
    assert.equal(redis("FLUSHALL", "SYNC"), "OK");
    assert.equal(redis("DBSIZE"), "0");
    docker("stop", ...Object.values(stack).filter((id) => id !== stack.worker));
  } finally {
    // Restart these same containers and their volumes without rerunning the seed job.
    docker(
      "start",
      stack.postgres,
      stack.redis,
      stack.storage,
      stack["model-double"],
    );
    docker(
      "start",
      stack.backend,
      stack.worker,
      ...(stack.frontend ? [stack.frontend] : []),
    );
  }
  await waitForLibrary();
  console.log(
    JSON.stringify({
      event: "stack-restarted",
      interruptedVersion: 2,
      interruptedStatus: "extracting",
      keysBeforeFlush,
      keysAfterFlush: 0,
      services: Object.keys(stack).sort(),
    }),
  );
}
const second = await until(
  path,
  (d) => d.status === "extracted" && d.version === 2,
);
assert.equal(second.values.length, 5);
assert.deepEqual(
  second.values.map((v) => v.field).sort(),
  first.values.map((v) => v.field).sort(),
);
assert.equal(new Set(second.values.map((v) => v.id)).size, 5);
const recoveredAt = Date.now();
assert.deepEqual(
  second.values
    .filter((v) => !v.carriedOver)
    .map((v) => v.field)
    .sort(),
  ["due_date", "total_amount"],
);
assert.deepEqual(second.progress, {
  pending: 2,
  carriedOver: 3,
  approved: 0,
  corrected: 0,
});
assert.equal(
  second.values.find((v) => v.field === "vendor_name").review.value,
  "Meridian Office Supplies",
);
assert.ok(
  second.values
    .filter((v) => !v.carriedOver)
    .every((v) => v.previous.review.action === "approve"),
);
for (const [question, mode] of [
  ["What is the exact vendor name?", "lexical"],
  ["What is the reviewer's corrected vendor name on this invoice?", "lexical"],
  ["Who supplied the goods?", "semantic"],
]) {
  const answer = await request(
    "/query",
    postJson({ question, documentId: receipt.id }),
  );
  assert.equal(answer.mode, mode);
  assert.equal(answer.answer, "Meridian Office Supplies");
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0].reviewed, true);
  assert.equal(answer.sources[0].version, 2);
  assert.equal(answer.sources[0].documentId, receipt.id);
}
const absent = await request(
  "/query",
  postJson({
    question: "What is the reviewer's corrected sales representative?",
    documentId: receipt.id,
  }),
);
assert.equal(absent.mode, "lexical");
assert.deepEqual(absent.sources, []);
assert.match(absent.answer, /couldn't find evidence/);
const history = await request(path + "?version=1");
assert.deepEqual(history, { ...reviewed, currentVersion: 2, versions: [2, 1] });
if (recovery) {
  console.log(
    JSON.stringify({
      event: "recovery-verified",
      documentId: receipt.id,
      interruptedAt: new Date(interruptedAt).toISOString(),
      recoveredAt: new Date(recoveredAt).toISOString(),
      recoveryMs: recoveredAt - interruptedAt,
      restoredStatus: second.status,
      preservedV1: reviewed.progress,
      uniqueV2Fields: second.values.length,
      v2: second.progress,
    }),
  );
}
const report = await until(
  "/documents/doc-report-001",
  (d) => d.status === "extracted",
);
const gap = report.values.find((v) => v.field === "median_household_income");
assert.equal(gap.value, null);
assert.match(gap.reason, /verbatim/i);

if (recovery) {
  const provider = stack["model-double"];
  const outageFlag = "/tmp/lomi-reject-extraction";
  let failedPath;
  docker("exec", provider, "touch", outageFlag);
  try {
    const submitted = await request("/documents", pdfUpload(invoice), 202);
    failedPath = "/documents/" + submitted.id;
    const failed = await until(failedPath, (doc) => doc.status === "failed");
    assert.match(failed.error, /provider returned HTTP 503/i);
    assert.deepEqual(failed.values, []);
  } finally {
    docker("exec", provider, "rm", "-f", outageFlag);
  }
  const retry = await request(failedPath + "/retry", { method: "POST" }, 202);
  assert.equal(retry.status, "queued");
  await request(failedPath + "/retry", { method: "POST" }, 409);
  const retried = await until(failedPath, (doc) => doc.status === "extracted");
  assert.equal(retried.error, null);
  assert.deepEqual(retried.versions, [1]);
  assert.deepEqual(retried.values.map((v) => v.field).sort(), [
    "due_date",
    "invoice_number",
    "issue_date",
    "total_amount",
    "vendor_name",
  ]);
  assert.equal(new Set(retried.values.map((v) => v.id)).size, 5);
  assert(
    retried.values.every(
      (v) => v.value && v.quote && retried.parsedText.includes(v.quote),
    ),
  );
  console.log(
    JSON.stringify({
      event: "provider-retry-verified",
      documentId: retried.id,
      fieldCount: retried.values.length,
    }),
  );
}

const batchPrefix = randomUUID();
const files = ["first.pdf", "second.pdf"].map((suffix) => ({
  name: batchPrefix + "-" + suffix,
  size: invoice.length,
  type: "invoice",
}));
const batch = await request("/uploads", postJson({ files }), 201);
async function store(target) {
  const form = new FormData();
  for (const [key, value] of Object.entries(target.fields))
    form.set(key, value);
  form.set(
    "file",
    new Blob([invoice], { type: "application/pdf" }),
    "invoice.pdf",
  );
  const response = await fetch(target.url, { method: "POST", body: form });
  assert.ok(response.ok, await response.text());
}
await store(batch.uploads[0]);
const complete = "/uploads/" + batch.batchId + "/complete";
await request(complete, postJson({}), 409);
const partial = await request("/documents");
assert(!partial.documents.some((doc) => doc.title.startsWith(batchPrefix)));
await store(batch.uploads[1]);
const result = await request(complete, postJson({}), 202);
assert.equal(result.documents.length, 2);
assert.deepEqual(
  (await request(complete, postJson({}), 202)).documents,
  result.documents,
);
const library = await request("/documents");
assert.deepEqual(
  library.documents
    .filter((doc) => doc.title.startsWith(batchPrefix))
    .map((doc) => doc.id)
    .sort(),
  result.documents.map((doc) => doc.id).sort(),
);
console.log(
  "Verified invoice revision, durable reviews, fabricated evidence rejection, and batch replay.",
);
