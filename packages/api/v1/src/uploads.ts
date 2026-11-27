import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { HttpError } from "@repo/common";
import { config } from "@repo/config";
import { createBatch, getDocument } from "@repo/drizzle";
import {
  saveBatch,
  loadBatch,
  pinBatch,
  acceptUploadBatch,
  type BatchFile,
} from "@repo/drizzle/batches";
import {
  classifyWithEvidence,
  parsePdf,
  presignUpload,
  putPdf,
  readPdf,
  verifyUpload,
} from "@repo/services";
import {
  batchId,
  batchManifest,
  completeBatch,
  filename,
  identifier,
  revisionFields,
  uploadFields,
} from "@repo/validators";
import { limit } from "./limits.ts";

export const uploads = Router();
const uploadLimit = limit(config.uploadsPerMinute);
const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileBytes,
    files: 1,
    fields: 2,
    fieldSize: 1000,
    parts: 4,
  },
}).single("file");

function objectKey() {
  return `documents/${randomUUID()}.pdf`;
}

async function revision(id: string) {
  const doc = await getDocument(id);
  if (doc.status === "queued" || doc.status === "extracting")
    throw new HttpError(
      409,
      "Retry the revision after the current extraction finishes.",
    );
  return doc;
}

uploads.post(
  ["/documents", "/documents/:id/versions"],
  uploadLimit,
  multipart,
  async (req, res) => {
    const file = req.file;
    if (!file)
      throw new HttpError(400, "Provide one PDF in the file form field");
    filename.parse(file.originalname);
    if (file.mimetype !== "application/pdf")
      throw new HttpError(415, "Use application/pdf for the file part");
    const id =
      req.params.id === undefined ? undefined : identifier.parse(req.params.id);
    const prior = id ? await revision(id) : undefined;
    const fields = (prior ? revisionFields : uploadFields).parse(req.body);
    if (prior && fields.type && fields.type !== prior.type)
      throw new HttpError(
        409,
        "The revision must use the existing document type",
      );
    const key = objectKey();
    const stored = await putPdf(key, file.buffer);
    const [document] = await createBatch([
      {
        id,
        key,
        ...stored,
        title: prior?.title ?? fields.title ?? file.originalname,
        type: fields.type ?? prior?.type ?? null,
      },
    ]);
    res.status(202).location(`/documents/${document.id}`).json(document);
  },
);

uploads.post("/uploads", uploadLimit, async (req, res) => {
  const { files } = batchManifest(
    config.maxFileBytes,
    config.maxBatchFiles,
  ).parse(req.body);
  const id = randomUUID();
  const manifest: BatchFile[] = [];
  const uploadTargets = [];
  const revisions = new Set<string>();
  for (const file of files) {
    if (file.documentId && revisions.has(file.documentId))
      throw new HttpError(
        400,
        "A batch may contain only one revision per document",
      );
    if (file.documentId) revisions.add(file.documentId);
    const prior = file.documentId ? await revision(file.documentId) : undefined;
    if (prior && file.type && prior.type !== file.type)
      throw new HttpError(
        409,
        "The revision must use the existing document type",
      );
    const key = objectKey();
    const itemId = randomUUID();
    manifest.push({
      id: itemId,
      key,
      documentId: file.documentId,
      type: prior?.type ?? file.type ?? null,
      title: prior?.title ?? file.name,
      size: file.size,
    });
    uploadTargets.push({
      id: itemId,
      ...(await presignUpload(key, file.size)),
    });
  }
  await saveBatch(id, manifest);
  res.status(201).json({ batchId: id, uploads: uploadTargets });
});

uploads.post("/uploads/:batchId/complete", uploadLimit, async (req, res) => {
  const id = batchId.parse(req.params.batchId);
  const { types } = completeBatch.parse(req.body ?? {});
  let batch = await loadBatch(id);
  if (batch.result) {
    res.status(202).json({ documents: batch.result });
    return;
  }
  if (
    types &&
    Object.keys(types).some(
      (key) => !batch.files.some((file) => file.id === key),
    )
  )
    throw new HttpError(
      400,
      "Type selection references a file outside this batch",
    );
  if (!batch.files[0]?.objectVersion) {
    const verified = [];
    for (const file of batch.files)
      verified.push({ ...file, ...(await verifyUpload(file.key, file.size)) });
    batch = await pinBatch(id, verified);
  }
  const items = [];
  const needsType: string[] = [];
  for (const file of batch.files) {
    const { key, objectVersion, contentHash } = file;
    if (!objectVersion || !contentHash)
      throw new Error("Incomplete verified manifest");
    const suppliedType = file.type ?? types?.[file.id];
    const classification = suppliedType
      ? null
      : await parsePdf(await readPdf(key, objectVersion)).then(
          classifyWithEvidence,
          () => null,
        );
    const type = suppliedType ?? classification?.type ?? null;
    if (!type) needsType.push(file.id);
    items.push({
      id: file.documentId,
      seedId: file.id,
      key,
      objectVersion,
      contentHash,
      size: file.size,
      title: file.title,
      type,
      metadata: classification ? { classification } : {},
    });
  }
  if (needsType.length) {
    res.status(422).json({
      message: "Choose a document type for each unrecognized PDF.",
      needsType,
    });
    return;
  }
  const documents = await acceptUploadBatch(id, items);
  res.status(202).json({ documents });
});
