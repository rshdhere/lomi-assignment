import { Readable, addAbortSignal } from "node:stream";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { config } from "@repo/config";
import { HttpError } from "@repo/common";

const storageTimeoutMs = 60_000;

const client = new S3Client({
  region: config.s3Region,
  endpoint: config.s3Endpoint,
  forcePathStyle: !!config.s3Endpoint,
});
const signer = new S3Client({
  region: config.s3Region,
  endpoint: config.s3PublicEndpoint,
  forcePathStyle: !!config.s3PublicEndpoint,
});

export async function presignUpload(key: string, bytesExact: number) {
  return createPresignedPost(signer, {
    Bucket: config.s3Bucket,
    Key: key,
    Expires: 3600,
    Fields: { "Content-Type": "application/pdf" },
    Conditions: [
      ["eq", "$Content-Type", "application/pdf"],
      ["content-length-range", bytesExact, bytesExact],
    ],
  });
}

export function validatePdfBytes(bytes: Buffer) {
  if (!bytes.length || bytes.length > config.maxFileBytes)
    throw new HttpError(413, "PDF exceeds the configured upload size");
  if (
    !/^%PDF-\d\.\d/.test(bytes.subarray(0, 10).toString("ascii")) ||
    !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
  )
    throw new HttpError(
      422,
      "The uploaded file is missing a PDF header or end marker",
    );
}

// Poppler also checks the cross-reference table and page tree. Both direct and
// multipart uploads pass the same parser before they can enter an extraction batch.
async function validatePdf(bytes: Buffer) {
  validatePdfBytes(bytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pdfinfo", ["-"], {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    child.stdin.on("error", () => {
      /* early parser exit is handled by close */
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new HttpError(422, "Invalid, encrypted, or unreadable PDF")),
    );
    child.stdin.end(bytes);
  });
}

function pinned(version?: string) {
  if (!version || version === "null")
    throw new Error("Enable bucket versioning before uploading PDFs");
  return version;
}
function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function putPdf(key: string, bytes: Buffer) {
  await validatePdf(bytes);
  const response = await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/pdf",
    }),
    { abortSignal: AbortSignal.timeout(storageTimeoutMs) },
  );
  return {
    objectVersion: pinned(response.VersionId),
    size: bytes.length,
    contentHash: digest(bytes),
  };
}

export async function readPdf(key: string, objectVersion: string) {
  const abortSignal = AbortSignal.timeout(storageTimeoutMs);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      VersionId: pinned(objectVersion),
    }),
    { abortSignal },
  );
  const body = response.Body;
  if (!(body instanceof Readable))
    throw new Error("Expected an S3 response stream");
  if (!response.ContentLength || response.ContentLength > config.maxFileBytes) {
    body.destroy();
    throw new HttpError(
      413,
      "Stored object exceeds the upload size limit or is empty",
    );
  }

  // The SDK resolves GET at headers. Bind its deadline to the body as well.
  addAbortSignal(abortSignal, body);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > response.ContentLength)
      throw new HttpError(422, "Stored object exceeds its declared length");
    chunks.push(chunk);
  }
  if (length !== response.ContentLength)
    throw new HttpError(422, "Stored object is incomplete");
  return Buffer.concat(chunks, length);
}

export async function verifyUpload(key: string, bytesExact: number) {
  const head = await client
    .send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(storageTimeoutMs),
    })
    .catch((error: unknown) => {
      const status =
        error instanceof Error
          ? Reflect.get(error, "$metadata")?.httpStatusCode
          : undefined;
      if (
        status === 403 ||
        status === 404 ||
        (error instanceof Error &&
          ["NotFound", "NoSuchKey", "AccessDenied", "Forbidden"].includes(
            error.name,
          ))
      )
        throw new HttpError(
          409,
          "One or more uploads are missing. Retry the unfinished files.",
        );
      throw error;
    });
  if (
    head.ContentLength !== bytesExact ||
    head.ContentType !== "application/pdf"
  )
    throw new HttpError(
      422,
      "Uploaded object does not match the declared PDF size and type",
    );
  const objectVersion = pinned(head.VersionId);
  const bytes = await readPdf(key, objectVersion);
  await validatePdf(bytes);
  return { objectVersion, size: bytes.length, contentHash: digest(bytes) };
}
