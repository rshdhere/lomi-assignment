import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readPdf, verifyUpload } from "../src/ingest.ts";

test("server verifies bytes from the S3 version returned by HEAD", async (t) => {
  const file = await readFile(
    new URL("../../../fixtures/documents/invoice-001.pdf", import.meta.url),
  );
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: HeadObjectCommand | GetObjectCommand) => {
      if (command instanceof HeadObjectCommand)
        return {
          ContentType: "application/pdf",
          ContentLength: file.length,
          VersionId: "pinned-v1",
        };
      assert.ok(command instanceof GetObjectCommand);
      assert.equal(command.input.VersionId, "pinned-v1");
      return {
        ContentLength: file.length,
        Body: Readable.from([file]),
      };
    },
  );
  assert.deepEqual(await verifyUpload("documents/one.pdf", file.length), {
    objectVersion: "pinned-v1",
    size: file.length,
    contentHash: createHash("sha256").update(file).digest("hex"),
  });
});
test("missing key behind private S3 permissions gives a retryable unfinished batch", async (t) => {
  t.mock.method(S3Client.prototype, "send", async () => {
    throw Object.assign(new Error("Forbidden"), { name: "Forbidden" });
  });
  await assert.rejects(verifyUpload("documents/missing.pdf", 42), {
    status: 409,
  });
});

test("a stalled S3 body is destroyed at the request deadline", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 60000);
    return controller.signal;
  });
  const stream = new Readable({
    read() {
      queueMicrotask(() => controller.abort());
    },
  });
  t.mock.method(
    S3Client.prototype,
    "send",
    async (
      _command: GetObjectCommand,
      options: { abortSignal: AbortSignal },
    ) => {
      assert.equal(options.abortSignal, controller.signal);
      return { ContentLength: 123, Body: stream };
    },
  );
  await assert.rejects(readPdf("documents/stalled.pdf", "v1"), {
    name: "AbortError",
  });
  assert.equal(stream.destroyed, true);
});
