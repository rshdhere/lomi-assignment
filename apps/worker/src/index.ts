import { setTimeout as delay } from "node:timers/promises";
import { Queue, Worker } from "bullmq";
import { config } from "@repo/config";
import {
  claimVersion,
  failClaim,
  finishClaim,
  pool,
  renewClaim,
  scheduledVersions,
} from "@repo/drizzle";
import {
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
const worker = new Worker<{ id: string }>(
  "extraction",
  async (job) => {
    const claim = await claimVersion(job.data.id);
    if (!claim) return;
    const heartbeat = setInterval(
      () =>
        void renewClaim(claim).catch((error) =>
          console.error("Claim renewal failed", error),
        ),
      20000,
    );
    try {
      const text = await parsePdf(
        await readPdf(claim.key, claim.objectVersion),
      );
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
      await finishClaim(
        claim,
        text,
        type,
        values,
        chunks,
        classification ? { ...metadata, classification } : metadata,
      );
    } catch (error) {
      await failClaim(
        claim,
        error instanceof Error ? error.message : "Extraction failed",
      );
    } finally {
      clearInterval(heartbeat);
    }
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
    const jobs = await scheduledVersions();
    await queue.addBulk(
      jobs.map(({ id }) => ({
        name: "extract",
        data: { id },
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
await pool.end();
