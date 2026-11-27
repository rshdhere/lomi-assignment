# Reviewer workspace

Open `http://localhost:3000` after starting the root Compose project. The document library shows the current extraction state, version, and count of reviewed fields. Selecting a document opens its values beside their verified passages. Use **Pending only** to focus on outstanding reviews.

Approve a value as extracted, or select **Correct value**, enter the correction and optionally add a note. A gap includes its reason. Use **Upload revision** with `fixtures/documents/invoice-001.v2.pdf` after reviewing the original invoice. Check the carried-over reviews and the previous values beside the changed due date and total. The version menu opens earlier evidence and reviews.

**Upload PDFs** submits a batch directly to signed object storage destinations. If a file fails, **Continue batch** retries outstanding transfers. If a link expires, choose the files again. Extraction begins after the API confirms the batch. **Ask documents** searches across the collection or the selected document and links its quoted sources to their document versions.

The browser fetches the library and selected detail every six seconds. This keeps extraction state and reviews current while leaving an open correction form in place. Set `NEXT_PUBLIC_API_ORIGIN` when building for an API outside `http://localhost:4000`. The API and object store both need to allow requests from the dashboard origin.

## Browser verification and screenshots

With the seeded stack running and an extraction API key configured, run the following in the cloud checkout from the repository root.

```sh
pnpm --filter web exec playwright install --with-deps chromium
pnpm --filter web test:e2e
```

The browser test creates a fresh invoice using the dashboard, records an approval and a correction, uploads the revised PDF, checks both pending fields and all three carried reviews, and opens version 1 again. It also checks the missing income field on the seeded report. Screenshots of the running application are saved to `apps/frontend/evidence/`.

### Captured fixture review

The screenshot shows the reviewer with **Pending only** selected for invoice v2. Both original PDFs were parsed with Poppler, processed with the integration model double, and persisted through Drizzle in PGlite with pgvector. The capture mounted the dashboard component with its real CSS and replayed those database results to the browser. It covers the revision display. The Playwright test above also exercises upload, polling and review actions against Compose.

![Revised invoice showing the changed due date and total beside their previous approved values](evidence/revision-fixture.png)
