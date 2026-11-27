import { sql } from "drizzle-orm";
import { HttpError } from "@repo/common";
import { db } from "./client.ts";
import { createBatch, type StoredUpload } from "./documents.ts";

export type BatchFile = {
  id: string;
  key: string;
  title: string;
  size: number;
  type: "invoice" | "lease" | "market_report" | null;
  documentId?: string;
  objectVersion?: string;
  contentHash?: string;
};
type BatchRow = {
  files: BatchFile[];
  result: { id: string; version: number; status: string }[] | null;
};

export async function saveBatch(id: string, files: BatchFile[]) {
  await db.execute(
    sql`DELETE FROM upload_batches WHERE created_at < now() - interval '1 day'`,
  );
  await db.execute(
    sql`INSERT INTO upload_batches (id,files) VALUES (${id},${JSON.stringify(files)}::jsonb)`,
  );
}
export async function loadBatch(id: string) {
  const { rows } = await db.execute<BatchRow>(sql`
    SELECT files, result FROM upload_batches WHERE id=${id} AND created_at > now() - interval '1 day'`);
  if (!rows[0]) throw new HttpError(404, "Upload batch is missing or expired");
  return rows[0];
}

// First completer pins the whole verified manifest. Every concurrent or subsequent
// completion uses those immutable S3 versions, even after another presigned POST.
export async function pinBatch(id: string, files: BatchFile[]) {
  await db.execute(sql`UPDATE upload_batches SET files=${JSON.stringify(files)}::jsonb
    WHERE id=${id} AND NOT ((files->0) ? 'objectVersion')`);
  return loadBatch(id);
}

export async function acceptUploadBatch(id: string, items: StoredUpload[]) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<BatchRow>(sql`
      SELECT result FROM upload_batches WHERE id=${id}
      AND created_at > now() - interval '1 day' FOR UPDATE`);
    const batch = rows[0];
    if (!batch) throw new HttpError(404, "Upload batch is missing or expired");
    if (batch.result) return batch.result;
    const documents = await createBatch(items, tx);
    await tx.execute(
      sql`UPDATE upload_batches SET result=${JSON.stringify(documents)}::jsonb WHERE id=${id}`,
    );
    return documents;
  });
}
