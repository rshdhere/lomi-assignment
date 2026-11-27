import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
// Set a deterministic HTTP budget before importing the application configuration.
process.env.MAX_FILE_BYTES = "10485760";
process.env.UPLOADS_PER_MINUTE = "5";
const { createApp } = await import("../src/app.ts");
const { config } = await import("@repo/config");

test("malformed uploads fail at HTTP ingestion and repeated requests receive a retry window", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const advertised = await (await fetch(base + "/limits")).json();
  assert.equal(advertised.maxFileBytes, config.maxFileBytes);

  const file = new FormData();
  file.set("type", "invoice");
  file.set(
    "file",
    new Blob(["%PDF-1.7\nThis is not a PDF document.\n%%EOF"], {
      type: "application/pdf",
    }),
    "invalid.pdf",
  );
  const invalid = await fetch(base + "/documents", {
    method: "POST",
    body: file,
  });
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).message, /unreadable PDF/);

  // A PDF can contain arbitrary whitespace before startxref. Its offsets remain valid.
  const original = await readFile(
    new URL("../../../fixtures/documents/invoice-001.pdf", import.meta.url),
  );
  const cut = original.lastIndexOf("startxref");
  const exactFile = new Blob(
    [
      Uint8Array.from(original.subarray(0, cut)),
      new Uint8Array(config.maxFileBytes - original.length).fill(32),
      Uint8Array.from(original.subarray(cut)),
    ],
    { type: "application/pdf" },
  );
  const boundary = new FormData();
  boundary.set("file", exactFile, "boundary.pdf");
  // Missing type fails *after* the complete file passed multipart size validation.
  const exact = await fetch(base + "/documents", {
    method: "POST",
    body: boundary,
  });
  assert.equal(exact.status, 400);
  assert.match((await exact.json()).message, /type/);
  boundary.set(
    "file",
    new Blob([exactFile, " "], { type: "application/pdf" }),
    "large.pdf",
  );
  const oversized = await fetch(base + "/documents", {
    method: "POST",
    body: boundary,
  });
  assert.equal(oversized.status, 413);

  // Manifest and multipart writes share the same admission budget.
  for (let attempt = 3; attempt < config.uploadsPerMinute; attempt++) {
    const empty = await fetch(base + "/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"files":[]}',
    });
    assert.equal(empty.status, 400);
  }
  const limited = await fetch(base + "/uploads", { method: "POST" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
});
