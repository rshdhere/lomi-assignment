import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app.ts";

test("multipart upload and revision emit their distinct route templates", async (t) => {
  const labels: string[] = [];
  const server = createApp((method) => ({
    run: (next) => next(),
    finish: (route) => labels.push(`${method} ${route}`),
  })).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  // Empty requests exercise the same matched routes without a PDF, database or provider.
  for (const path of [
    "/documents",
    "/documents/private-document-id/versions",
  ]) {
    assert.equal((await fetch(base + path, { method: "POST" })).status, 400);
  }
  assert.equal((await fetch(base + "/private-unmatched-url")).status, 404);
  assert.deepEqual(labels, [
    "POST /documents",
    "POST /documents/:id/versions",
    "GET unmatched",
  ]);
});
