import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/client.ts";
import { migrate } from "../src/migrations.ts";
import {
  createBatch,
  getDocument,
  reviewValue,
  retryDocument,
} from "../src/documents.ts";
import {
  claimVersion,
  finishClaim,
  failClaim,
  getExtractionQueueSnapshot,
  scheduledVersions,
  reviewedSources,
  searchChunks,
  type Value,
} from "../src/extraction.ts";

// Run against a disposable pgvector database with RUN_DB_TESTS=1 and DATABASE_URL.
test(
  "durable claims, retry and repeated completion preserve version history and reviews",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async () => {
    await migrate();
    const prefix = randomUUID();
    const item = {
      title: "Recovery test",
      type: "invoice" as const,
      key: prefix,
      objectVersion: "one",
      size: 12,
      contentHash: "a",
    };
    const [doc] = await createBatch([item]);
    const versionId = async (version: number) =>
      (
        await db.execute<{
          id: string;
        }>(sql`select version_id as id from document_versions
    where doc_id=${doc!.id} and version=${version}`)
      ).rows[0]!.id;
    const makeValues = (amount: string, vendor = "Meridian LLC"): Value[] => [
      { field: "vendor", value: vendor, quote: "Meridian LLC", reason: null },
      { field: "number", value: "01", quote: "Invoice 01", reason: null },
      {
        field: "amount",
        value: amount,
        quote: "Total " + amount,
        reason: null,
      },
    ];
    try {
      assert.deepEqual(await createBatch([item]), [doc]);
      const first = await versionId(1);
      assert.ok((await scheduledVersions()).some((r) => r.id === first));
      const waiting = await getExtractionQueueSnapshot();
      assert.ok(waiting.queued >= 1);
      assert.ok(waiting.oldestQueuedSeconds >= 0);
      const stale = (await claimVersion(first))!;
      assert.equal(await claimVersion(first), undefined);
      await assert.rejects(
        createBatch([{ ...item, id: doc!.id, key: prefix + "-busy" }]),
        /current extraction/,
      );
      await db.execute(
        sql`update document_versions set lease_until=now()-interval '1 second' where version_id=${first}`,
      );
      const interrupted = await getExtractionQueueSnapshot();
      assert.ok(interrupted.extracting >= 1);
      assert.ok(interrupted.expiredClaims >= 1);
      const fresh = (await claimVersion(first))!;
      await failClaim(stale, "stale response");
      assert.equal((await getDocument(doc!.id)).status, "extracting");
      const text = "Meridian LLC\nInvoice 01\nTotal 10";
      const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
      await finishClaim(
        fresh,
        text,
        "invoice",
        makeValues("10"),
        [{ text, embedding: vector, metadata: { section: 1 } }],
        {},
      );
      await finishClaim(stale, "wrong", "invoice", [], [], {});
      await finishClaim(fresh, text, "invoice", makeValues("10"), [], {});
      const v1 = await getDocument(doc!.id);
      assert.equal(v1.values.length, 3);
      for (const value of v1.values) {
        await reviewValue(
          value.id,
          value.field === "number"
            ? { action: "correct", value: "001", note: "Validated" }
            : { action: "approve" },
        );
      }
      const target = v1.values[0]!;
      const decisions = await Promise.allSettled(
        [1, 2].map(() =>
          reviewValue(target.id, {
            action: target.field === "number" ? "correct" : "approve",
            value: "001",
            expectedRevision: 1,
          }),
        ),
      );
      assert.equal(decisions.filter((d) => d.status === "fulfilled").length, 1);
      const history = await db.execute(
        sql`select 1 from review_history where value_id=${target.id}`,
      );
      assert.equal(history.rowCount, 2);
      const lexical = await searchChunks(
        "lexical",
        "invoice",
        undefined,
        doc!.id,
      );
      const semantic = await searchChunks(
        "semantic",
        "billing",
        vector,
        doc!.id,
      );
      assert.equal(lexical[0]?.text, text);
      assert.equal(semantic[0]?.id, lexical[0]?.id);
      const reviewed = await reviewedSources(
        "invoice",
        lexical.map((c) => c.id),
        doc!.id,
      );
      assert.equal(reviewed.find((s) => s.field === "number")?.value, "001");
      await createBatch([
        { ...item, id: doc!.id, objectVersion: "two", contentHash: "b" },
      ]);
      assert.deepEqual(
        await searchChunks("lexical", "invoice", undefined, doc!.id),
        [],
      );
      const second = await versionId(2);
      const failed = (await claimVersion(second))!;
      await failClaim(failed, "temporary provider failure");
      assert.equal((await getDocument(doc!.id)).status, "failed");
      await retryDocument(doc!.id);
      const retry = (await claimVersion(second))!;
      await finishClaim(
        retry,
        "Heading\nMeridian LLC\nInvoice 01\nTotal 11",
        "invoice",
        makeValues("11", "Other vendor"),
        [],
        {},
      );
      await assert.rejects(
        createBatch([
          { ...item, id: doc!.id, key: prefix + "-stale", expectedVersion: 1 },
        ]),
        /newer version/,
      );
      const revised = await getDocument(doc!.id);
      assert.deepEqual(revised.progress, {
        approved: 0,
        corrected: 0,
        pending: 1,
        carriedOver: 2,
      });
      assert.equal(
        revised.values.find((v) => v.field === "number")?.review?.value,
        "001",
      );
      assert.equal(
        revised.values.find((v) => v.field === "amount")?.previous?.review
          ?.action,
        "approve",
      );
      const vendor = revised.values.find((v) => v.field === "vendor");
      assert.equal(vendor?.value, "Meridian LLC");
      assert.equal(vendor?.review?.action, "approve");
      assert.equal((await getDocument(doc!.id, 1)).parsedText, text);
      await assert.rejects(
        reviewValue(v1.values[0]!.id, { action: "approve" }),
        /Historical/,
      );
    } finally {
      // Rows are isolated by random document ID. Clean only the test's own records.
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from chunks where doc_id=${doc!.id}`);
        await tx.execute(
          sql`delete from reviews where value_id in (select e.value_id from extracted_values e join document_versions v using(version_id) where v.doc_id=${doc!.id})`,
        );
        await tx.execute(
          sql`delete from extracted_values where version_id in (select version_id from document_versions where doc_id=${doc!.id})`,
        );
        await tx.execute(
          sql`delete from extraction_attempts where version_id in (select version_id from document_versions where doc_id=${doc!.id})`,
        );
        await tx.execute(
          sql`delete from document_versions where doc_id=${doc!.id}`,
        );
        await tx.execute(sql`delete from documents where doc_id=${doc!.id}`);
      });
      await pool.end();
    }
  },
);
