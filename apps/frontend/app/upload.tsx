import UploadFolder from "./ui/folder/UploadFolder";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DocumentType, UploadBatch } from "@repo/types/reviewer";
import { api, ApiError, errorMessage, post, typeLabels } from "./client";
import { Button } from "./ui/button";
import { WorkspaceIcon } from "./workspace-icon";
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
  expectedVersion,
  close,
  done,
}: {
  documentId?: string;
  expectedVersion?: number;
  close: () => void;
  done: (id: string) => void;
}) {
  const [baseVersion] = useState(expectedVersion);
  const manifestKey = useRef<{ body: string; key: string } | null>(null);
  const [limits, setLimits] = useState<Limits>();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [batch, setBatch] = useState<UploadBatch>();
  const [dragging, setDragging] = useState(false);
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
    manifestKey.current = null;
    setBatch(undefined);
    setEntries([]);
    setNeedsType([]);
    setMessage("");
    if (!limits || !files.length) return;
    if (documentId && files.length !== 1) {
      setMessage("Choose one PDF for the revised version.");
      return;
    }
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
      const body = JSON.stringify({
        files: entries.map(({ file, type }) => ({
          name: file.name,
          size: file.size,
          ...(documentId ? { documentId, expectedVersion: baseVersion } : {}),
          ...(type ? { type } : {}),
        })),
      });
      if (manifestKey.current?.body !== body)
        manifestKey.current = { body, key: crypto.randomUUID() };
      const session =
        batch ??
        (await api<UploadBatch>("/uploads", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": manifestKey.current.key,
          },
          body,
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
      if (error instanceof ApiError && error.needsType.length) {
        setNeedsType(error.needsType);
      }
      setMessage(errorMessage(error));
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
      <form className="sheet-form" onSubmit={submit}>
        <p className="sheet-description">
          {documentId
            ? "Earlier versions and their reviews stay available."
            : "Upload PDFs, then review each result."}
        </p>
        <div
          className="upload-drop-zone"
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = busy || !limits ? "none" : "copy";
            setDragging(!busy && !!limits);
          }}
          onDragLeave={(event) => {
            if (!(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!busy && limits)
              void select(Array.from(event.dataTransfer.files));
          }}
        >
          <label className={`sheet-picker${dragging ? " dragging" : ""}`}>
            <span className="sheet-picker-title" id="upload-picker-label">
              {dragging
                ? "Drop PDFs here"
                : documentId
                  ? "Choose a revised PDF"
                  : "Choose PDF files"}
            </span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              aria-labelledby="upload-picker-label"
              aria-describedby="upload-picker-limits"
              multiple={!documentId}
              disabled={busy || !limits}
              onChange={(e) => {
                void select(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = "";
              }}
            />
            <small id="upload-picker-limits">
              {limits ? (
                <>
                  Up to{" "}
                  {Math.round((limits.maxFileBytes / 1024 / 1024) * 10) / 10}{" "}
                  MiB per file
                  {!documentId && `, ${limits.maxBatchFiles} per batch`}
                </>
              ) : message ? (
                "Upload limits unavailable"
              ) : (
                "Checking upload limits…"
              )}
            </small>
            <span className="picker-arrow" aria-hidden="true">
              ↑
            </span>
          </label>
          <UploadFolder dragging={dragging} />
        </div>
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
          <ul className="sheet-files" role="list">
            {entries.map((entry, i) => (
              <li key={i}>
                <div className="sheet-file-name">
                  <strong>{entry.file.name}</strong>
                  <small>
                    {Math.ceil(entry.file.size / 1024).toLocaleString()} KiB
                    {entry.stored && " · Stored"}
                  </small>
                </div>
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
        {step && (
          <p className="upload-progress" role="status">
            {step}
          </p>
        )}
        <footer className="sheet-actions">
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button className="upload-action" variant="default" disabled={busy || !entries.length}>
            {documentId
              ? "Upload revision"
              : batch
                ? "Continue batch"
                : "Upload PDFs"}
            <span className="upload-disc"><WorkspaceIcon name="uploadFile" /></span>
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
