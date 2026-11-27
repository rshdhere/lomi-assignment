import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(
  new URL("../../../fixtures/documents/", import.meta.url),
);
const screenshots = fileURLToPath(new URL("../evidence/", import.meta.url));

test("review an invoice, revise it, and inspect a seeded report gap", async ({
  page,
}) => {
  // This test exercises the actual provider and stack. Work on a fresh document each run.
  await mkdir(screenshots, { recursive: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Market report excerpt/ })
    .first()
    .click();
  const gap = page.locator("article.field").filter({
    has: page.getByRole("heading", { name: "Median household income" }),
  });
  await expect(gap.getByText("Gap", { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await page.screenshot({
    path: screenshots + "report-gap.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Upload PDFs", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(fixtures + "invoice-001.pdf");
  await dialog.getByRole("combobox").selectOption("invoice");
  await dialog
    .getByRole("button", { name: "Upload PDFs", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("h1")).toHaveText("invoice-001.pdf");
  const fields = page.locator("article.field");
  await expect(fields).toHaveCount(5, { timeout: 120_000 });
  const vendor = fields.filter({
    has: page.getByRole("heading", { name: "Vendor name" }),
  });
  await vendor.getByRole("button", { name: "Correct value" }).click();
  await vendor
    .getByLabel("Corrected value")
    .fill("Meridian Office Supplies LLC");
  await vendor.getByLabel("Note (optional)").fill("Normalized capitalization.");
  await vendor.getByRole("button", { name: "Save correction" }).click();
  await expect(vendor.locator(".review-state")).toHaveText("Corrected");
  for (const field of await fields.all()) {
    const state = field.locator(".review-state");
    if ((await state.textContent()) === "Pending") {
      await field.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(state).toHaveText("Approved");
    }
  }
  await page.screenshot({
    path: screenshots + "invoice-reviewed.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Upload revision" }).click();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles(fixtures + "invoice-001.v2.pdf");
  await dialog
    .getByRole("button", { name: "Upload revision", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByLabel("Document version").locator("option:checked"),
  ).toHaveText("Latest (v2)");
  await expect(page.locator(".review-state.pending")).toHaveCount(2, {
    timeout: 120_000,
  });
  await expect(page.getByText(/Carried over ·/)).toHaveCount(3);
  for (const label of ["Due date", "Total amount"]) {
    const field = fields.filter({
      has: page.getByRole("heading", { name: label }),
    });
    await expect(field.getByText("Previous version")).toBeVisible();
    await expect(field.locator(".review-state")).toHaveText("Pending");
  }
  await page.screenshot({
    path: screenshots + "invoice-revised.png",
    fullPage: true,
  });
  await page.getByLabel("Document version").selectOption("1");
  await expect(vendor.locator(".review-state")).toHaveText("Corrected");
  await expect(page.getByRole("button", { name: "Correct value" })).toHaveCount(
    0,
  );
});
