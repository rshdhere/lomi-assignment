import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { parsePdf } from "../src/pdf.ts";
import { classifyRegex } from "../src/classify.ts";
import { validateValues, segmentText } from "../src/evidence.ts";

test("validates quotations verbatim, including whitespace, and records reasons for missing fields", () => {
  const fields = [{ field: "id" }, { field: "total" }, { field: "term" }];
  const values = validateValues(
    fields,
    [
      { field: "id", value: "07", quote: "Invoice 07" },
      { field: "total", value: "25", quote: "Total: 25" },
    ],
    "Invoice 07\nTotal:  25",
  );
  assert.equal(values[0]?.quote, "Invoice 07");
  assert.equal(values[1]?.value, null);
  assert.match(values[1]!.reason!, /verbatim/);
  assert.equal(values[2]?.value, null);
  assert.ok(values[2]?.reason);
});
test("model section boundaries preserve every nonblank line of the source", () => {
  assert.deepEqual(segmentText("a\nb\nc\nd", [99, 3, 3, -1]), ["a\nb", "c\nd"]);
});
test("classifies fixture PDF text and declines ambiguity", async () => {
  for (const [file, type] of [
    ["invoice-001", "invoice"],
    ["market-report-excerpt-001", "market_report"],
    ["lease-excerpt-001", "lease"],
  ]) {
    const bytes = await readFile(
      new URL(`../../../fixtures/documents/${file}.pdf`, import.meta.url),
    );
    assert.equal(classifyRegex(await parsePdf(bytes)), type);
  }
  assert.equal(classifyRegex("Household survey"), null);
  assert.equal(classifyRegex("invoice invoice number landlord tenant"), null);
});
