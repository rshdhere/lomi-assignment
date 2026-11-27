// With --recovery this also interrupts the worker and clears the dedicated test Redis.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const api = "http://localhost:14000";
const compose = (...args) =>
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      "lomi-check",
      "-f",
      "compose.yaml",
      "-f",
      "tests/integration/compose.yaml",
      ...args,
    ],
    { stdio: "inherit" },
  );
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
    assert.notEqual(doc.status, "failed", doc.error);
    if (predicate(doc)) return doc;
    await delay(250);
  }
  throw Error("Timed out waiting for " + path);
}
const invoice = await readFile("fixtures/documents/invoice-001.pdf");
const revised = await readFile("fixtures/documents/invoice-001.v2.pdf");
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
const receipt = await request("/documents", pdfUpload(invoice), 202);
const path = "/documents/" + receipt.id;
await request(path + "/versions", pdfUpload(revised), 409);
if (process.argv.includes("--recovery")) {
  await until(path, (d) => d.status === "extracting");
  compose("kill", "-s", "SIGKILL", "worker");
  compose("exec", "-T", "redis", "redis-cli", "FLUSHALL");
  compose("up", "-d", "worker");
}
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
await request(path + "/versions", pdfUpload(revised), 202);
const second = await until(
  path,
  (d) => d.status === "extracted" && d.version === 2,
);
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
}
const history = await request(path + "?version=1");
assert.equal(history.parsedText, first.parsedText);
assert.deepEqual(
  history.values.map((i) => i.id),
  first.values.map((i) => i.id),
);
const report = await until(
  "/documents/doc-report-001",
  (d) => d.status === "extracted",
);
const gap = report.values.find((v) => v.field === "median_household_income");
assert.equal(gap.value, null);
assert.match(gap.reason, /verbatim/i);

const files = ["first.pdf", "second.pdf"].map((name) => ({
  name,
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
await store(batch.uploads[1]);
const result = await request(complete, postJson({}), 202);
assert.equal(result.documents.length, 2);
assert.deepEqual(
  (await request(complete, postJson({}), 202)).documents,
  result.documents,
);
console.log(
  "Verified invoice revision, durable reviews, fabricated evidence rejection, and batch replay.",
);
