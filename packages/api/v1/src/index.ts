import { Router, type ErrorRequestHandler } from "express";
import multer from "multer";
import { config } from "@repo/config";
import {
  getDocument,
  getProgress,
  listDocuments,
  listDocumentPage,
  retryDocument,
  reviewValue,
} from "@repo/drizzle";
import { answerQuestion } from "@repo/services";
import {
  identifier,
  pageSize,
  question,
  review,
  versionNumber,
  ZodError,
} from "@repo/validators";
import { uploads } from "./uploads.ts";
import { limit } from "./limits.ts";

export const api = Router();
api.use(uploads);
api.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
api.get("/limits", (_req, res) => {
  res.json({
    maxFileBytes: config.maxFileBytes,
    maxBatchFiles: config.maxBatchFiles,
  });
});
api.get("/documents", async (req, res) => {
  if (req.query.limit !== undefined || req.query.cursor !== undefined) {
    const limit = pageSize.parse(req.query.limit ?? 50);
    const cursor = identifier.optional().parse(req.query.cursor);
    res.json(await listDocumentPage(limit, cursor));
    return;
  }
  res.json({ documents: await listDocuments() });
});
api.get("/documents/:id", async (req, res) => {
  const version =
    req.query.version === undefined
      ? undefined
      : versionNumber.parse(req.query.version);
  res.json(await getDocument(identifier.parse(req.params.id), version));
});
api.get("/documents/:id/progress", async (req, res) => {
  res.json(await getProgress(identifier.parse(req.params.id)));
});
api.post(
  "/documents/:id/retry",
  limit(config.uploadsPerMinute),
  async (req, res) => {
    const id = identifier.parse(req.params.id);
    await retryDocument(id);
    res.status(202).json({ id, status: "queued" });
  },
);
api.post(
  "/values/:id/review",
  limit(config.reviewsPerMinute),
  async (req, res) => {
    await reviewValue(identifier.parse(req.params.id), review.parse(req.body));
    res.status(200).json({ saved: true });
  },
);
api.post("/query", limit(config.queriesPerMinute), async (req, res) => {
  const input = question.parse(req.body);
  res.json(await answerQuestion(input.question, input.documentId));
});

export const errorResponse: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      message: err.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(". "),
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    res
      .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      .json({ message: err.message });
    return;
  }
  if (
    err instanceof Error &&
    /^(Multipart:|Unexpected end of form|Unexpected end of file|Malformed part header)/.test(
      err.message,
    )
  ) {
    res.status(400).json({ message: "Malformed multipart upload" });
    return;
  }
  const status = Number(err.status);
  if (status >= 400 && status < 500) {
    res.status(status).json({
      message:
        err.type === "entity.parse.failed"
          ? "Invalid JSON request"
          : err.message,
    });
    return;
  }
  console.error(
    "Request failed",
    err instanceof Error ? err.name : "Unknown error",
  );
  res.status(503).json({
    message:
      "A required service is unavailable. Check the API and worker configuration and retry.",
  });
};
