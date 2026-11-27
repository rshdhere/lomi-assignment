import assert from "node:assert/strict";
import { test } from "node:test";
import { validateValues } from "../src/evidence.ts";

test("resolves copied prompt numbers only against the complete original source line", () => {
  const line = "Reporting Period: Q3 2025";
  const text = "Market report\n\n\n" + line;
  const check = (quote: string) =>
    validateValues(
      [{ field: "quarter" }],
      [{ field: "quarter", value: "Q3 2025", quote }],
      text,
    )[0];
  assert.equal(check("4\t" + line)?.quote, line);
  for (const bad of [
    "3\t" + line,
    "4\tReporting Period: Q4 2025",
    "4\tReporting  Period: Q3 2025",
  ]) {
    assert.equal(check(bad)?.value, null);
  }
});
