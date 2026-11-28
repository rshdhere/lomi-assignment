import { z } from "zod";

export const documentType = z.enum(["invoice", "lease", "market_report"]);
export const identifier = z.string().regex(/^[\w-]{1,128}$/);
export const pageSize = z.coerce.number().int().min(1).max(100);
export const versionNumber = z.coerce.number().int().min(1).max(2147483647);
const expectedRevision = z.number().int().nonnegative().optional();
export const review = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), expectedRevision }).strict(),
  z
    .object({
      action: z.literal("correct"),
      expectedRevision,
      value: z.string().trim().min(1).max(4000),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
]);
export const uploadFields = z
  .object({
    type: documentType,
    title: z.string().trim().min(1).max(250).optional(),
  })
  .strict();
export const filename = z
  .string()
  .trim()
  .min(5)
  .max(250)
  .regex(/^[^/\\]+\.pdf$/i, "Use a PDF filename")
  .refine(
    (name) => Array.from(name).every((char) => char.charCodeAt(0) >= 32),
    "Invalid filename",
  );
export function batchManifest(maxBytes: number, maxFiles: number) {
  return z
    .object({
      files: z
        .array(
          z
            .object({
              name: filename,
              size: z.number().int().min(1).max(maxBytes),
              type: documentType.optional(),
              documentId: identifier.optional(),
              expectedVersion: z.number().int().positive().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(maxFiles),
    })
    .strict();
}
export const completeBatch = z
  .object({
    types: z.record(z.uuid(), documentType).optional(),
  })
  .strict();
export const question = z
  .object({
    question: z.string().trim().min(1).max(2000),
    documentId: identifier.optional(),
  })
  .strict();
export const fixtureManifest = z.array(
  z.object({
    id: identifier,
    type: documentType,
    title: z.string(),
    versions: z.array(z.object({ version: versionNumber, file: z.string() })),
  }),
);
export type DocumentType = z.infer<typeof documentType>;
export type ReviewInput = z.infer<typeof review>;
export type UploadFile = z.infer<
  ReturnType<typeof batchManifest>
>["files"][number];

export const batchId = z.uuid();
export const revisionFields = uploadFields
  .partial()
  .extend({ expectedVersion: versionNumber.optional() });
export { ZodError } from "zod";
