import { test } from "node:test";
import assert from "node:assert/strict";
import { canCarryReview } from "../src/extraction.ts";

test("carry approvals and corrections only for unchanged, non-gap evidence", () => {
  assert.equal(canCarryReview("Invoice INV-01", "Invoice INV-01", true), true);
  assert.equal(canCarryReview("Total 25.00", "Total 26.00", true), false);
  assert.equal(canCarryReview("Total 25.00", "Total 25.00", false), false);
  assert.equal(canCarryReview(null, null, true), false);
});
