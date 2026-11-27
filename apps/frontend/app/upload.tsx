import { useEffect, useState, type FormEvent } from "react";
import type { DocumentType, UploadBatch } from "@repo/types/reviewer";
import { api, ApiError, errorMessage, post, typeLabels } from "./client";
import { Modal } from "./modal";

interface FileEntry {
  file: File;
  type: DocumentType | "";
  stored: boolean;
}
interface Limits {
  maxFileBytes: number;
  maxBatchFiles: number;
}

export function Upload({
  documentId,
  close,
  done,
}: {
  documentId?: string;
  close: () => void;
  done: (id: string) => void;
}) {
  const [limits, setLimits] = useState<Limits>();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [batch, setBatch] = useState<UploadBatch>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [needsType, setNeedsType] = useState<string[]>([]);
  const [step, setStep] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<Limits>("/limits", { signal: controller.signal })
      .then(setLimits)
      .catch((error) => {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      });
    return () => controller.abort();
  }, [attempt]);

  async function select(files: File[]) {
    setBatch(undefined);
    setEntries([]);
    setNeedsType([]);
    setMessage("");
    if (!limits || !files.length) return;
    if (files.length > limits.maxBatchFiles) {
      setMessage(`Select up to ${limits.maxBatchFiles} PDFs per upload.`);
      return;
    }
    setBusy(true);
    try {
      for (const file of files) {
        if (file.size > limits.maxFileBytes)
          throw new Error(`${file.name} exceeds the file size limit.`);
        if (
          !/\.pdf$/i.test(file.name) ||
          (file.type && file.type !== "application/pdf") ||
          !(await file.slice(0, 5).text()).startsWith("%PDF-")
        )
          throw new Error(`Choose a PDF file for ${file.name}.`);
      }
      setEntries(files.map((file) => ({ file, type: "", stored: false })));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !entries.length) return;
    setBusy(true);
    setMessage("");
    try {
      setStep("Preparing upload…");
      const session =
        batch ??
        (await post<UploadBatch>("/uploads", {
          files: entries.map(({ file, type }) => ({
            name: file.name,
            size: file.size,
            ...(documentId ? { documentId } : {}),
            ...(type ? { type } : {}),
          })),
        }));
      setBatch(session);
      setStep("Uploading PDFs…");
      // Keep successful uploads when another file fails. Wait for every attempt before enabling retry.
      const results = await Promise.allSettled(
        session.uploads.map(async (upload, i) => {
          const entry = entries[i]!;
          if (entry.stored) return;
          const form = new FormData();
          for (const [name, value] of Object.entries(upload.fields))
            form.append(name, value);
          form.append("file", entry.file);
          const result = await fetch(upload.url, {
            method: "POST",
            body: form,
          });
          if (!result.ok)
            throw new Error(
              `Storage rejected ${entry.file.name} (${result.status}). Retry, or select the files again for a new upload link.`,
            );
          setEntries((old) =>
            old.map((item, index) =>
              index === i ? { ...item, stored: true } : item,
            ),
          );
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      setStep("Checking batch…");
      const types = Object.fromEntries(
        session.uploads.flatMap(({ id }, i) =>
          entries[i]?.type ? [[id, entries[i].type]] : [],
        ),
      );
      const result = await post<{ documents: { id: string }[] }>(
        `/uploads/${encodeURIComponent(session.batchId)}/complete`,
        { types },
      );
      done(result.documents[0]!.id);
    } catch (error) {
      setMessage(errorMessage(error));
      if (error instanceof ApiError) setNeedsType(error.needsType);
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  return (
    <Modal
      title={documentId ? "Upload a new version" : "Upload documents"}
      close={close}
      busy={busy}
    >
      <form onSubmit={submit}>
        <p className="muted">
          {documentId
            ? "Earlier versions and their reviews stay available."
            : "Send a batch of PDFs and review each document as extraction finishes."}
        </p>
        <label className="file-picker">
          <span>
            {documentId ? "Choose a revised PDF" : "Choose PDF files"}
          </span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            multiple={!documentId}
            disabled={busy || !limits}
            onChange={(e) => {
              void select(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
          {limits && (
            <small>
              Up to {Math.round((limits.maxFileBytes / 1024 / 1024) * 10) / 10}{" "}
              MiB per file{!documentId && `, ${limits.maxBatchFiles} per batch`}
            </small>
          )}
        </label>
        {!limits && message && (
          <button
            type="button"
            onClick={() => {
              setMessage("");
              setAttempt((n) => n + 1);
            }}
          >
            Retry connection
          </button>
        )}
        {entries.length > 0 && (
          <ul className="upload-list">
            {entries.map((entry, i) => (
              <li key={i}>
                <span>
                  {entry.file.name}
                  {entry.stored && <small>Stored</small>}
                </span>
                {!documentId && (
                  <select
                    aria-label={`Document type for ${entry.file.name}`}
                    disabled={
                      busy ||
                      (!!batch &&
                        !needsType.includes(batch.uploads[i]?.id ?? ""))
                    }
                    required={needsType.includes(batch?.uploads[i]?.id ?? "")}
                    value={entry.type}
                    onChange={(event) =>
                      setEntries((items) =>
                        items.map((item, index) =>
                          index === i
                            ? {
                                ...item,
                                type: event.target.value as FileEntry["type"],
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="">Detect type</option>
                    {Object.entries(typeLabels).map(([type, label]) => (
                      <option key={type} value={type}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        )}
        {message && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        {step && <p role="status">{step}</p>}
        <footer className="actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !entries.length}>
            {documentId
              ? "Upload revision"
              : batch
                ? "Continue batch"
                : "Upload PDFs"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
