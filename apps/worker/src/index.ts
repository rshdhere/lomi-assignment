import {
  extractionTelemetry,
  extractionStage,
  observeQueue,
  startTelemetry,
} from "@repo/common/telemetry";
import { setTimeout as delay } from "node:timers/promises";
import { Queue, Worker } from "bullmq";
import { config } from "@repo/config";
import {
  claimVersion,
  getExtractionQueueSnapshot,
  failClaim,
  finishClaim,
  pool,
  renewClaim,
  reserveExtractionOffers,
} from "@repo/drizzle";
import {
  TransientProviderError,
  classifyWithEvidence,
  extractVersion,
  parsePdf,
  readPdf,
} from "@repo/services";

const redis = new URL(config.redisUrl);
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: decodeURIComponent(redis.username) || undefined,
  password: decodeURIComponent(redis.password) || undefined,
  db: Number(redis.pathname.slice(1) || 0),
  ...(redis.protocol === "rediss:" ? { tls: {} } : {}),
};
const queue = new Queue("extraction", { connection });
const telemetry = await startTelemetry("lomi-worker");
const observeAttempt = telemetry ? extractionTelemetry() : undefined;
if (telemetry) observeQueue(getExtractionQueueSnapshot);

async function processVersion(
  id: string,
): Promise<"extracted" | "failed" | "skipped"> {
  const claim = await claimVersion(id);
  if (!claim) return "skipped";
  const heartbeat = setInterval(
    () =>
      void renewClaim(claim).catch((error) =>
        console.error("Claim renewal failed", error),
      ),
    20000,
  );
  try {
    const bytes = await extractionStage("read pinned PDF", () =>
      readPdf(claim.key, claim.objectVersion),
    );
    const text = await extractionStage("parse PDF", () => parsePdf(bytes));
    const { type, values, chunks, metadata } = await extractionStage(
      "extract and enrich",
      async () => {
        const classification = claim.type
          ? null
          : await classifyWithEvidence(text);
        const type = claim.type ?? classification?.type;
        if (!type)
          throw new Error(
            "Document type is unclear. Upload with an explicit document type.",
          );
        const { values, chunks, metadata } = await extractVersion(
          claim,
          text,
          type,
        );
        return {
          type,
          values,
          chunks,
          metadata: classification ? { ...metadata, classification } : metadata,
        };
      },
    );
    const committed = await extractionStage("commit extraction", () =>
      finishClaim(claim, text, type, values, chunks, metadata),
    );
    return committed ? "extracted" : "skipped";
  } catch (error) {
    await failClaim(
      claim,
      error instanceof Error ? error.message : "Extraction failed",
      error instanceof TransientProviderError
        ? Math.max(
            error.retryAfterMs,
            2 ** claim.attempt * 1000 + Math.random() * 1000,
          )
        : undefined,
    );
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}
const worker = new Worker<{ id: string; traceparent?: string }>(
  "extraction",
  async (job) => {
    const work = () => processVersion(job.data.id);
    if (observeAttempt) await observeAttempt(job.data.traceparent, work);
    else await work();
  },
  { connection, concurrency: config.workerConcurrency },
);

queue.on("error", (error) =>
  console.error("Queue connection error", error.message),
);
worker.on("error", (error) =>
  console.error("Worker connection error", error.message),
);
worker.on("failed", (job, error) =>
  console.error("Queue attempt failed", job?.id, error.message),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    stopping = true;
  });

// This scan deliberately has no Redis cursor. Postgres remains sufficient to
// reconstruct all outstanding work after a queue flush or missed publish.
while (!stopping) {
  try {
    const jobs = await reserveExtractionOffers();
    await queue.addBulk(
      jobs.map(({ id, traceparent }) => ({
        name: "extract",
        data: traceparent ? { id, traceparent } : { id },
        opts: { jobId: id, removeOnComplete: true, removeOnFail: true },
      })),
    );
  } catch (error) {
    console.error("Extraction reconciliation failed", error);
  }
  await delay(1500);
}
await worker.close();
await queue.close();
await telemetry?.shutdown();
await pool.end();
