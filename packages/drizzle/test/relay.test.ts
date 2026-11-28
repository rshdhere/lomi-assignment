import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/client.ts";
import { migrate } from "../src/migrations.ts";
import { reserveExtractionOffers } from "../src/extraction.ts";

test(
  "two relays share more than one publication batch and reoffer missed writes",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async () => {
    const doc = randomUUID();
    try {
      await migrate();
      const seeded = await db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into documents(doc_id,title) values(${doc},'Relay backlog')`,
        );
        const rows = await tx.execute<{
          id: string;
        }>(sql`insert into document_versions(doc_id,version,object_key,object_version,content_hash,size_bytes)
        select ${doc},i,${doc}||'-'||i,'one','hash',1 from generate_series(1,140) as i returning version_id as id`);
        await tx.execute(sql`update stage_work set next_offer_at='-infinity' where version_id in
        (select version_id from document_versions where doc_id=${doc})`);
        return new Set(rows.rows.map((r) => r.id));
      });
      const [a, b] = await Promise.all([
        reserveExtractionOffers(),
        reserveExtractionOffers(),
      ]);
      const offered = [...a, ...b]
        .filter((r) => seeded.has(r.id))
        .map((r) => r.id);
      assert.equal(offered.length, 140);
      assert.deepEqual(new Set(offered), seeded);
      const missing = offered[0]!;
      // Neither publisher writes to Redis. Advance one publication lease in SQL.
      await db.execute(
        sql`update stage_work set next_offer_at='-infinity' where version_id=${missing}`,
      );
      assert((await reserveExtractionOffers()).some((r) => r.id === missing));
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from document_versions where doc_id=${doc}`,
        );
        await tx.execute(sql`delete from documents where doc_id=${doc}`);
      });
      await pool.end();
    }
  },
);
