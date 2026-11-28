import type { DocumentType } from "@repo/validators";
export type { DocumentType };
export type ExtractionStatus = "queued" | "extracting" | "extracted" | "failed";
export type Progress = {
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
};
export interface DocumentSummary {
  id: string;
  title: string;
  type: DocumentType;
  version: number;
  status: ExtractionStatus;
  progress: Progress;
  updatedAt: string;
  error: string | null;
}
export interface FieldReview {
  action: "approve" | "correct";
  value: string | null;
  note: string | null;
}
export interface ExtractedField {
  reviewRevision?: number;
  id: string;
  field: string;
  value: string | null;
  quote: string | null;
  reason: string | null;
  review: FieldReview | null;
  carriedOver: boolean;
  previous: Pick<ExtractedField, "value" | "quote" | "review"> | null;
}
export interface DocumentDetail extends DocumentSummary {
  versions: number[];
  parsedText: string | null;
  values: ExtractedField[];
}
export interface UploadBatch {
  batchId: string;
  uploads: { id: string; url: string; fields: Record<string, string> }[];
}
export interface QueryResult {
  answer: string;
  sources: {
    id: string;
    documentId: string;
    title: string;
    version: number;
    quote: string;
    field?: string;
    value?: string;
    reviewed: boolean;
  }[];
}
