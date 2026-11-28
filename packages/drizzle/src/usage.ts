import { sql } from "drizzle-orm";
import { db } from "./client.ts";

export async function recordProviderUsage(row: {
  attempt?: string;
  operation: string;
  requested: string;
  returned?: string;
  requestId: string | null;
  input?: number;
  output?: number;
  elapsed: number;
  status: number;
}) {
  await db.execute(sql`insert into provider_usage(attempt_token,operation,requested_model,returned_model,provider_request_id,input_tokens,output_tokens,elapsed_ms,http_status)
    values(${row.attempt ?? null},${row.operation},${row.requested},${row.returned ?? null},${row.requestId},${row.input ?? null},${row.output ?? null},${row.elapsed},${row.status})`);
}
