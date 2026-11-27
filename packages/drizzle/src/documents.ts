import { currentTraceparent } from "@repo/common/telemetry";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./client.ts";

export type DocumentType = "invoice" | "lease" | "market_report";
export type Status = "queued" | "extracting" | "extracted" | "failed";
export type Review = {
  action: "approve" | "correct";
  value?: string | null;
  note?: string | null;
};
export type StoredUpload = {
  id?: string;
  seedId?: string;
  title: string;
  type: DocumentType | null;
  key: string;
  objectVersion: string;
  size: number;
  contentHash: string;
  metadata?: Record<string, unknown>;
};
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type Receipt = { id: string; version: number; status: Status };

export async function createBatch(
  items: StoredUpload[],
  connection: Pick<typeof db, "transaction"> = db,
): Promise<Receipt[]> {
  return connection.transaction(async (tx) => {
    // Serialize replays before looking up their immutable storage version.
    for (const key of [...new Set(items.map((item) => item.key))].sort()) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 10))`,
      );
    }
    for (const id of [
      ...new Set(items.flatMap((item) => (item.id ? [item.id] : []))),
    ].sort()) {
      const locked = await tx.execute(
        sql`select doc_id from documents where doc_id=${id} for update`,
      );
      if (!locked.rowCount) throw new ApiError(404, "Document not found");
    }
    const receipts: Receipt[] = [];
    for (const item of items) {
      const replay =
        await tx.execute<Receipt>(sql`select doc_id as id,version,status from document_versions
        where object_key=${item.key} and object_version=${item.objectVersion}`);
      if (replay.rows[0]) {
        receipts.push(replay.rows[0]);
        continue;
      }
      const id = item.id ?? item.seedId ?? randomUUID();
      let version = 1;
      let type = item.type;
      if (item.id) {
        const previous = await tx.execute<{
          version: number;
          status: Status;
          document_type: DocumentType | null;
        }>(sql`
          select version,status,document_type from document_versions where doc_id=${id} order by version desc limit 1`);
        const last = previous.rows[0]!;
        if (last.status === "extracting" || last.status === "queued")
          throw new ApiError(409, "Wait for the current extraction to finish");
        if (type && last.document_type && type !== last.document_type)
          throw new ApiError(
            409,
            "Document type differs from the previous version",
          );
        type ??= last.document_type;
        version = last.version + 1;
      } else {
        await tx.execute(
          sql`insert into documents(doc_id,title) values (${id},${item.title})`,
        );
      }
      const traceparent = currentTraceparent();
      const metadata = traceparent
        ? { ...item.metadata, traceparent }
        : item.metadata;
      await tx.execute(sql`insert into document_versions
        (doc_id,version,document_type,object_key,object_version,size_bytes,content_hash,metadata)
        values (${id},${version},${type},${item.key},${item.objectVersion},${item.size},${item.contentHash},${JSON.stringify(metadata ?? {})}::jsonb)`);
      receipts.push({ id, version, status: "queued" });
    }
    return receipts;
  });
}

type Summary = {
  id: string;
  title: string;
  type: DocumentType | null;
  currentVersion: number;
  version: number;
  status: Status;
  error: string | null;
  updatedAt: Date;
  progress: {
    pending: number;
    approved: number;
    corrected: number;
    carriedOver: number;
  };
};

const summary = sql`select d.doc_id as id, d.title, v.document_type as type, v.version,
  (select max(version) from document_versions where doc_id=d.doc_id) as "currentVersion",
  v.status, v.error, v.updated_at as "updatedAt",
  (select json_build_object(
    'pending',count(*) filter(where r.action is null),
    'approved',count(*) filter(where r.action='approve' and not e.carried_over),
    'corrected',count(*) filter(where r.action='correct' and not e.carried_over),
    'carriedOver',count(*) filter(where e.carried_over))
    from extracted_values e left join reviews r using (value_id) where e.version_id=v.version_id) as progress`;

export async function listDocuments() {
  return (
    await db.execute<Summary>(sql`${summary} from documents d
    join lateral (select * from document_versions where doc_id=d.doc_id order by version desc limit 1) v on true
    order by v.updated_at desc, d.doc_id`)
  ).rows;
}

export async function getDocument(id: string, version?: number) {
  const result = await db.execute<
    Summary & {
      versionId: string;
      parsedText: string | null;
      versions: number[];
    }
  >(sql`
    ${summary}, v.version_id as "versionId", v.parsed_text as "parsedText",
    array(select version from document_versions where doc_id=d.doc_id order by version desc) as versions
    from documents d join document_versions v using(doc_id)
    where d.doc_id=${id} ${version === undefined ? sql`` : sql`and v.version=${version}`}
    order by v.version desc limit 1`);
  if (!result.rows[0]) throw new ApiError(404, "Document or version not found");
  const { versionId, ...doc } = result.rows[0];
  const values = await db.execute<{
    id: string;
    field: string;
    value: string | null;
    quote: string | null;
    reason: string | null;
    review: Review | null;
    carriedOver: boolean;
    previous: {
      value: string | null;
      quote: string | null;
      review: Review | null;
    } | null;
  }>(sql`select e.value_id as id,e.field,e.value,e.quote,e.gap_reason as reason,
    case when r.action is not null then json_build_object('action',r.action,'value',r.correction,'note',r.note) end as review,
    e.carried_over as "carriedOver",
    case when p.value_id is not null then json_build_object('value',p.value,'quote',p.quote,'review',
      case when pr.action is not null then json_build_object('action',pr.action,'value',pr.correction,'note',pr.note) end) end as previous
    from extracted_values e left join reviews r on r.value_id=e.value_id
    left join extracted_values p on p.value_id=e.previous_id left join reviews pr on pr.value_id=p.value_id
    where e.version_id=${versionId} order by e.field`);
  return { ...doc, values: values.rows };
}

export async function getProgress(id: string) {
  const row = (
    await db.execute<Summary>(sql`${summary} from documents d join document_versions v using(doc_id)
    where d.doc_id=${id} order by v.version desc limit 1`)
  ).rows[0];
  if (!row) throw new ApiError(404, "Document not found");
  return row.progress;
}

export async function reviewValue(id: string, review: Review) {
  return db.transaction(async (tx) => {
    const found = await tx.execute<{
      version: number;
      doc_id: string;
    }>(sql`select v.version,d.doc_id from extracted_values e
      join document_versions v using(version_id) join documents d using(doc_id) where e.value_id::text=${id} for update of d`);
    const row = found.rows[0];
    if (!row) throw new ApiError(404, "Value not found");
    const newer = await tx.execute(
      sql`select 1 from document_versions where doc_id=${row.doc_id} and version>${row.version}`,
    );
    if (newer.rowCount)
      throw new ApiError(409, "Historical reviews are read-only");
    if (review.action === "correct" && !review.value?.trim())
      throw new ApiError(400, "A correction needs a value");
    await tx.execute(sql`insert into reviews(value_id,action,correction,note)
      values (${id},${review.action},${review.action === "correct" ? review.value : null},${review.note ?? null})
      on conflict(value_id) do update set action=excluded.action,correction=excluded.correction,note=excluded.note,updated_at=now()`);
    await tx.execute(
      sql`update extracted_values set carried_over=false where value_id=${id}`,
    );
  });
}

export async function retryDocument(id: string) {
  await db.transaction(async (tx) => {
    const doc = await tx.execute(
      sql`select 1 from documents where doc_id=${id} for update`,
    );
    if (!doc.rowCount) throw new ApiError(404, "Document not found");
    const traceparent = currentTraceparent();
    const changed =
      await tx.execute(sql`update document_versions set status='queued', error=null, updated_at=now(),
        metadata=(metadata - 'traceparent') || ${JSON.stringify(traceparent ? { traceparent } : {})}::jsonb
      where doc_id=${id} and status='failed' and version=(select max(version) from document_versions where doc_id=${id})`);
    if (!changed.rowCount)
      throw new ApiError(409, "Only failed extractions can be retried");
  });
}
