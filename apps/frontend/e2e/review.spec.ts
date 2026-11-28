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
  await page.goto("/workspace");
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
  const picker = dialog.locator('input[type="file"]');
  // Each newly opened dialog fetches its upload limits before accepting files.
  await expect(picker).toBeEnabled();
  await picker.setInputFiles(fixtures + "invoice-001.pdf");
  await dialog.getByRole("combobox").selectOption("invoice");
  await dialog
    .getByRole("button", { name: "Upload PDFs", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#document-detail h2.document-title")).toHaveText(
    "invoice-001.pdf",
  );
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
      await page.getByRole("button", { name: "Confirm approval" }).click();
      await expect(state).toHaveText("Approved");
    }
  }
  await page.screenshot({
    path: screenshots + "invoice-reviewed.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Upload revision" }).click();
  await expect(picker).toBeEnabled();
  await picker.setInputFiles(fixtures + "invoice-001.v2.pdf");
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

test("browse the mobile library and open the cited document version", async ({
  page,
}) => {
  const invoice = "Invoice — Meridian Office Supplies";
  const report = "Market report excerpt — Eastport Rental Market, Q3";
  const lease = "Lease excerpt — 1200 Harbor Street, Unit 4B";
  const invoiceId = "doc-invoice-001";
  const title = page.locator("#document-detail h2.document-title");
  const library = page.getByRole("table", { name: "Document library" });
  const uploadAction = page.getByRole("button", {
    name: "Upload PDFs",
    exact: true,
  });
  const ask = page.getByRole("button", { name: "Ask documents", exact: true });
  const browse = page.getByRole("button", { name: "Browse", exact: true });
  const workspaceNavigation = page.getByRole("navigation", {
    name: "Workspace navigation",
  });

  await mkdir(screenshots, { recursive: true });
  await page.goto("/workspace");
  const search = page.getByRole("searchbox", { name: "Find a document" });
  await search.fill("excerpt");
  await library.getByRole("button", { name: new RegExp(report) }).click();
  await expect(title).toHaveText(report);
  await expect(page.getByRole("heading", { name: "Market area" })).toBeVisible({
    timeout: 120_000,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: screenshots + "workspace-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(browse).toBeVisible();
  await expect(workspaceNavigation).toBeHidden();
  await expect(library).toBeHidden();
  await expect(ask).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: screenshots + "workspace-mobile.png" });

  await uploadAction.click();
  const upload = page.getByRole("dialog", { name: "Upload documents" });
  await expect(
    upload.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(upload).toBeHidden();
  await expect(uploadAction).toBeFocused();

  await browse.click();
  await expect(workspaceNavigation).toBeVisible();
  await ask.click();
  const askDialog = page.getByRole("dialog", { name: "Ask your documents" });
  await expect(askDialog).toBeVisible();
  await expect(workspaceNavigation).toBeHidden();
  await askDialog.getByRole("button", { name: "Close dialog" }).click();

  await browse.click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await search.fill("1200 Harbor Street");
  await expect(library.getByRole("button")).toHaveCount(1);
  await library.getByRole("button", { name: new RegExp(lease) }).click();
  await expect(title).toHaveText(lease);
  await expect(browse).toHaveAttribute("aria-expanded", "false");

  // Only the generated answer is fixed. The library and cited version are served by the API.
  const question = "What is the Meridian invoice number?";
  const answer = "The invoice number is INV-2025-0847.";
  const quote = "Invoice Number: INV-2025-0847";
  await page.route("**/query", (route) =>
    route.fulfill({
      json: {
        answer: answer + " [invoice-number]",
        sources: [
          {
            id: "invoice-number",
            documentId: invoiceId,
            title: invoice,
            version: 1,
            quote,
            field: "invoice_number",
            value: "INV-2025-0847",
            reviewed: false,
          },
        ],
        mode: "lexical",
      },
    }),
  );
  await browse.click();
  await ask.click();
  const dialog = page.getByRole("dialog", { name: "Ask your documents" });
  await expect(dialog.getByLabel("Search in")).toHaveValue("");
  const composer = dialog.getByLabel("Question", { exact: true });
  await composer.fill(question);
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue(question + "\n");
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/query",
    ),
    composer.press("Enter"),
  ]);
  expect(request.postDataJSON()).toEqual({ question });
  await expect(
    dialog.getByText(answer + " [1]", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(quote, { exact: true })).toBeVisible();
  const sourceReview = dialog.getByText("Invoice number · Unreviewed", {
    exact: true,
  });
  await expect(sourceReview).toBeVisible();
  await sourceReview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshots + "query-mobile.png" });

  await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/documents/" + invoiceId &&
        url.searchParams.get("version") === "1" &&
        response.ok()
      );
    }),
    dialog
      .getByRole("button", { name: invoice + " · v1", exact: true })
      .click(),
  ]);
  await expect(dialog).toBeHidden();
  await expect(title).toHaveText(invoice);
  await expect(
    page.getByText("View parsed text · v1", { exact: true }),
  ).toBeVisible();
});
