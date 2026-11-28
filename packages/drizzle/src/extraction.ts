import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./client.ts";
import type { DocumentType } from "./documents.ts";

export type Value = {
  field: string;
  value: string | null;
  quote: string | null;
  reason: string | null;
};
export type Chunk = {
  text: string;
  embedding: number[];
  metadata: Record<string, unknown>;
};
export type Claim = {
  versionId: string;
  id: string;
  version: number;
  key: string;
  objectVersion: string;
  type: DocumentType | null;
  token: string;
  attempt: number;
};

/** Durable backlog, including work not currently present in Redis. */
export async function getExtractionQueueSnapshot() {
  const { rows } = await db.execute<{
    queued: number;
    extracting: number;
    expiredClaims: number;
    oldestQueuedSeconds: number;
  }>(sql`select
    (count(*) filter (where status='queued'))::int as queued,
    (count(*) filter (where status='extracting'))::int as extracting,
    (count(*) filter (where status='extracting' and lease_until<now()))::int as "expiredClaims",
    coalesce(extract(epoch from now() - min(updated_at) filter (where status='queued')), 0)::float8 as "oldestQueuedSeconds"
    from document_versions where status in ('queued','extracting')`);
  return rows[0]!;
}

export async function scheduledVersions() {
  return (
    await db.execute<{
      id: string;
      traceparent: string | null;
    }>(sql`select version_id as id, metadata->>'traceparent' as traceparent from document_versions
    where (status='queued' and eligible_at<=now()) or (status='extracting' and lease_until<now()) order by updated_at limit 100`)
  ).rows;
}
export async function claimVersion(id: string): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const token = randomUUID();
    await tx.execute(sql`update document_versions set status='failed',error='Extraction attempt budget exhausted after worker interruption',
      claim_token=null,lease_until=null,updated_at=now()
      where version_id=${id} and status='extracting' and lease_until<now() and cycle_attempts>=3`);
    const row = (
      await tx.execute<Claim>(sql`update document_versions set status='extracting',
      cycle_attempts=cycle_attempts+1,attempt_deadline=now()+interval '10 minutes',claim_token=${token},lease_until=now()+interval '90 seconds',updated_at=now()
      where version_id=${id} and ((status='queued' and eligible_at<=now()) or (status='extracting' and lease_until<now()))
      returning version_id as "versionId",doc_id as id,version,object_key as key,
      object_version as "objectVersion",document_type as type,claim_token as token,cycle_attempts as attempt`)
    ).rows[0];
    if (row)
      await tx.execute(
        sql`insert into extraction_attempts(claim_token,version_id) values (${token},${id})`,
      );
    return row;
  });
}
export async function renewClaim(claim: Claim) {
  await db.execute(sql`update document_versions set lease_until=least(now()+interval '90 seconds',attempt_deadline)
    where version_id=${claim.versionId} and claim_token=${claim.token}`);
}
export async function recordAttempt(
  token: string,
  prompt: string,
  raw: string | null,
) {
  await db.execute(
    sql`update extraction_attempts set prompt=${prompt},raw_response=${raw} where claim_token=${token}`,
  );
}
export async function failClaim(
  claim: Claim,
  error: string,
  retryDelayMs?: number,
) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`update extraction_attempts set error=${error} where claim_token=${claim.token}`,
    );
    await tx.execute(sql`update document_versions set status=${retryDelayMs !== undefined && claim.attempt < 3 ? "queued" : "failed"},eligible_at=now()+${retryDelayMs ?? 0}::double precision * interval '1 millisecond',error=${error},claim_token=null,
      lease_until=null,updated_at=now() where version_id=${claim.versionId} and claim_token=${claim.token}`);
  });
}

// Exact quote comparison ignores absolute offsets. Review carry-over also requires both
// quotes to have passed validation against their own version's text.
export function canCarryReview(
  oldQuote: string | null | undefined,
  newQuote: string | null,
  reviewed: boolean,
) {
  return reviewed && !!newQuote && oldQuote === newQuote;
}
export async function finishClaim(
  claim: Claim,
  text: string,
  type: DocumentType,
  values: Value[],
  chunks: Chunk[],
  metadata: Record<string, unknown>,
  pendingSections?: Omit<Chunk, "embedding">[],
) {
  return db.transaction(async (tx) => {
    const own =
      await tx.execute(sql`select 1 from document_versions where version_id=${claim.versionId}
      and claim_token=${claim.token} and (attempt_deadline is null or attempt_deadline>now()) for update`);
    if (!own.rowCount) return false;
    const previous = await tx.execute<{
      id: string;
      field: string;
      value: string | null;
      quote: string | null;
      action: string | null;
      correction: string | null;
      note: string | null;
    }>(sql`
      select e.value_id as id,e.field,e.value,e.quote,r.action,r.correction,r.note
      from document_versions v join extracted_values e using(version_id) left join reviews r using(value_id)
      where v.doc_id=${claim.id} and v.version=${claim.version - 1}`);
    const byField = new Map(previous.rows.map((row) => [row.field, row]));
    for (const value of values) {
      const old = byField.get(value.field);
      const carry = canCarryReview(old?.quote, value.quote, !!old?.action);
      // An approval attaches to the specific value the reviewer saw. The model
      // may render a different value from identical evidence on a later run.
      const start = value.quote ? text.indexOf(value.quote) : -1;
      const trustedValue =
        carry && old?.action === "approve" ? old.value : value.value;
      const id = randomUUID();
      await tx.execute(sql`insert into extracted_values
        (value_id,version_id,field,value,quote,gap_reason,previous_id,carried_over,model_value,quote_start,quote_end)
        values (${id},${claim.versionId},${value.field},${trustedValue},${value.quote},${value.reason},${old?.id ?? null},${carry},${value.value},${start < 0 ? null : start},${start < 0 ? null : start + value.quote!.length})`);
      if (carry && old) {
        await tx.execute(
          sql`insert into reviews(value_id,action,correction,note) values (${id},${old.action},${old.correction},${old.note})`,
        );
      }
    }
    for (const chunk of chunks) {
      await tx.execute(sql`insert into chunks(version_id,doc_id,doc_type,metadata,text,embedding)
        values (${claim.versionId},${claim.id},${type},${JSON.stringify(chunk.metadata)}::jsonb,${chunk.text},${JSON.stringify(chunk.embedding)}::vector)`);
    }
    if (pendingSections)
      await tx.execute(
        sql`insert into stage_work(version_id,stage,sections) values(${claim.versionId},'index',${JSON.stringify(pendingSections)}::jsonb)`,
      );
    await tx.execute(sql`update document_versions set indexing_status=${pendingSections ? "queued" : "ready"}, parsed_text=${text}, document_type=${type},
      metadata=metadata || ${JSON.stringify(metadata)}::jsonb,status='extracted',error=null,claim_token=null,lease_until=null,updated_at=now()
      where version_id=${claim.versionId}`);
    return true;
  });
}
export type SearchHit = {
  id: string;
  documentId: string;
  title: string;
  version: number;
  text: string;
};
export async function searchChunks(
  mode: "lexical" | "semantic",
  query: string,
  vector: number[] | undefined,
  documentId?: string,
) {
  const lexicalQuery = sql`websearch_to_tsquery('english',${query})`;
  return (
    await db.execute<SearchHit>(sql`select c.chunk_id as id,c.doc_id as "documentId",d.title,v.version,c.text
    from chunks c join document_versions v using(version_id) join documents d on c.doc_id=d.doc_id
    where v.status='extracted' and v.version=(select max(version) from document_versions newer where newer.doc_id=c.doc_id)
    ${documentId ? sql`and c.doc_id=${documentId}` : sql``}
    ${
      mode === "lexical"
        ? sql`and c.terms @@ ${lexicalQuery} order by ts_rank(c.terms,${lexicalQuery}) desc`
        : sql`order by c.embedding <=> ${JSON.stringify(vector)}::vector`
    }
    limit 6`)
  ).rows;
}

export type Source = {
  id: string;
  documentId: string;
  title: string;
  version: number;
  quote: string;
  field?: string;
  value?: string;
  reviewed: boolean;
};
export async function reviewedSources(
  query: string,
  chunkIds: string[],
  documentId?: string,
  question?: string,
): Promise<Source[]> {
  const terms = sql`websearch_to_tsquery('english',${query})`;
  const reviewedText = sql`to_tsvector('english',replace(e.field,'_',' ') || ' ' || coalesce(r.correction,e.value,'') || ' ' || coalesce(e.quote,''))`;
  // A tool's lexical rewrite may include words like "corrected" that never
  // appear in the PDF. Within one document the question can name a field directly.
  const namedField =
    documentId && question
      ? sql`to_tsvector('english',${question}) @@ phraseto_tsquery('english',replace(e.field,'_',' '))`
      : sql`false`;
  return (
    await db.execute<Source>(sql`select e.value_id as id,d.doc_id as "documentId",d.title,v.version,
    coalesce(e.quote,'') as quote,e.field,coalesce(r.correction,e.value) as value,true as reviewed
    from extracted_values e join reviews r using(value_id) join document_versions v using(version_id)
    join documents d using(doc_id)
    where v.status='extracted' and coalesce(r.correction,e.value) is not null
    and v.version=(select max(version) from document_versions newer where newer.doc_id=v.doc_id)
    ${documentId ? sql`and d.doc_id=${documentId}` : sql``}
    and (${namedField} or ${reviewedText} @@ ${terms} or exists(select 1 from chunks c where
      c.chunk_id in (select jsonb_array_elements_text(${JSON.stringify(chunkIds)}::jsonb)::uuid)
      and c.version_id=v.version_id and strpos(c.text,e.quote)>0))
    order by ${documentId && question ? sql`(${namedField}) desc,` : sql``}ts_rank(${reviewedText},${terms}) desc,e.field limit 20`)
  ).rows;
}

// A short publication lease covers both a missed Redis write and a later Redis flush.
export async function reserveExtractionOffers() {
  return (
    await db.execute<{
      id: string;
      stage: string;
      traceparent: string | null;
    }>(sql`
    with due as (
      select w.version_id,w.stage,w.generation,v.metadata->>'traceparent' as traceparent
      from stage_work w join document_versions v using(version_id)
      where w.next_offer_at<=now()
        and ((v.status='queued' and v.eligible_at<=now())
          or (v.status='extracting' and v.lease_until<now()) or (w.stage='index' and v.indexing_status in ('queued','indexing')))
      order by w.next_offer_at,w.version_id limit 100 for update of w skip locked
    )
    update stage_work w set next_offer_at=now()+interval '10 seconds'
    from due where (w.version_id,w.stage,w.generation)=(due.version_id,due.stage,due.generation)
    returning w.version_id as id,w.stage,due.traceparent`)
  ).rows;
}

export async function claimIndex(id: string) {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      sections: Omit<Chunk, "embedding">[];
    }>(sql`
      update stage_work set owner_token=${token}, next_offer_at=now()+interval '10 minutes'
      where version_id=${id} and stage='index' and ((owner_token is null and exists(select 1 from document_versions where version_id=${id} and indexing_status='queued')) or exists(
        select 1 from document_versions where version_id=${id} and indexing_status='indexing'
        and updated_at < now()-interval '10 minutes')) returning sections`);
    if (!claimed.rows[0]) return;
    await tx.execute(
      sql`update document_versions set indexing_status='indexing',updated_at=now() where version_id=${id}`,
    );
    return { token, sections: claimed.rows[0].sections };
  });
}
export async function completeIndex(
  id: string,
  token: string,
  result: Chunk[] | string,
) {
  return db.transaction(async (tx) => {
    const owned = await tx.execute(
      sql`select 1 from stage_work where version_id=${id} and stage='index' and owner_token=${token} for update`,
    );
    if (!owned.rowCount) return false;
    if (typeof result === "string") {
      await tx.execute(
        sql`update document_versions set indexing_status='failed',indexing_error=${result},updated_at=now() where version_id=${id}`,
      );
      await tx.execute(
        sql`update stage_work set owner_token=null,next_offer_at=now() where version_id=${id} and stage='index'`,
      );
    } else {
      for (const chunk of result)
        await tx.execute(sql`insert into chunks(version_id,doc_id,doc_type,metadata,text,embedding)
        select version_id,doc_id,document_type,${JSON.stringify(chunk.metadata)}::jsonb,${chunk.text},${JSON.stringify(chunk.embedding)}::vector
        from document_versions where version_id=${id}`);
      await tx.execute(
        sql`update document_versions set indexing_status='ready',indexing_error=null,updated_at=now() where version_id=${id}`,
      );
      await tx.execute(
        sql`delete from stage_work where version_id=${id} and stage='index'`,
      );
    }
    return true;
  });
}
