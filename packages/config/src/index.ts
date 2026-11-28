function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  modelContextBudget: positiveInteger("MODEL_CONTEXT_BUDGET", 262144),
  modelOutputReserve: positiveInteger("MODEL_OUTPUT_RESERVE", 8192),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/lomi",
  workerConcurrency: positiveInteger("WORKER_CONCURRENCY", 2),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-6-luna",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  port: positiveInteger("PORT", 4000),
  trustSingleProxy: process.env.TRUST_SINGLE_PROXY === "true",
  uiOrigin: process.env.UI_ORIGIN ?? "http://localhost:3000",
  maxFileBytes: positiveInteger("MAX_FILE_BYTES", 10 * 1024 * 1024),
  maxBatchFiles: positiveInteger("MAX_BATCH_FILES", 10),
  uploadsPerMinute: positiveInteger("UPLOADS_PER_MINUTE", 20),
  queriesPerMinute: positiveInteger("QUERIES_PER_MINUTE", 15),
  reviewsPerMinute: positiveInteger("REVIEWS_PER_MINUTE", 120),
  fixturesDir:
    process.env.FIXTURES_DIR ??
    new URL("../../../fixtures/", import.meta.url).pathname,
  s3Bucket: process.env.S3_BUCKET ?? "lomi-documents",
  s3Region: process.env.S3_REGION ?? "us-east-1",
  s3Endpoint: process.env.S3_ENDPOINT,
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT,
};
