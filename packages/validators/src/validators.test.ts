import assert from "node:assert/strict";
import test from "node:test";
import { batchManifest, review } from "./index.ts";

test("PDF upload manifest enforces limits at both boundaries", () => {
  const schema = batchManifest(1024, 2);
  const file = { name: "invoice.PDF", size: 1024 };
  assert.ok(schema.safeParse({ files: [file, file] }).success);
  for (const files of [
    [],
    [file, file, file],
    [{ ...file, size: 1025 }],
    [{ ...file, name: "../invoice.pdf" }],
  ]) {
    assert.equal(schema.safeParse({ files }).success, false);
  }
});
test("corrections require a nonblank value and approval cannot replace it", () => {
  assert.equal(
    review.safeParse({ action: "correct", value: " " }).success,
    false,
  );
  assert.equal(
    review.safeParse({ action: "approve", value: "new" }).success,
    false,
  );
  assert.ok(
    review.safeParse({
      action: "correct",
      value: "450",
      note: "from amendment",
    }).success,
  );
});
