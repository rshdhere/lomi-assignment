"use client";

import { useEffect, useState } from "react";
import type {
  DocumentDetail,
  DocumentSummary,
  Progress,
} from "@repo/types/reviewer";
import { api, errorMessage, post, typeLabels } from "./client";
import { Ask } from "./ask";
import { ReviewField } from "./review";
import { Upload } from "./upload";

const statusLabels = {
  queued: "Queued",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Failed",
};

function progressText(progress: Progress) {
  const reviewed =
    progress.approved + progress.corrected + progress.carriedOver;
  return `${reviewed} of ${reviewed + progress.pending} reviewed`;
}

// A fresh request is scheduled after the previous one settles so slow responses cannot overlap.
function useResource<T>(path: string | null, change: number) {
  const [result, setResult] = useState<{
    path: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) setResult({ path: path!, data });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult((old) => ({
            ...(old?.path === path ? old : {}),
            path: path!,
            error: errorMessage(error),
          }));
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 6000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, change]);
  return result?.path === path ? result : undefined;
}

function Detail({
  doc,
  latest,
  version,
  setVersion,
  upload,
  refresh,
}: {
  doc: DocumentDetail;
  latest: number;
  version: number | null;
  setVersion: (n: number | null) => void;
  upload: () => void;
  refresh: () => void;
}) {
  const [onlyPending, setOnlyPending] = useState(false);
  const [retryError, setRetryError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const current = doc.version === latest;
  const fields = onlyPending
    ? doc.values.filter((item) => !item.review)
    : doc.values;
  async function retry() {
    setRetrying(true);
    setRetryError("");
    try {
      await post(`/documents/${encodeURIComponent(doc.id)}/retry`);
      refresh();
    } catch (error) {
      setRetryError(errorMessage(error));
    } finally {
      setRetrying(false);
    }
  }
  return (
    <>
      <div className="doc-tools">
        <span className="doc-kind">{typeLabels[doc.type]}</span>
        <label className="version-label">
          Viewing{" "}
          <select
            aria-label="Document version"
            value={version ?? ""}
            onChange={(e) =>
              setVersion(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Latest (v{latest})</option>
            {doc.versions
              .filter((n) => n !== latest)
              .map((n) => (
                <option key={n} value={n}>
                  Version {n}
                </option>
              ))}
          </select>
        </label>
      </div>
      <h1>{doc.title}</h1>
      <div className="detail-meta">
        <span className={`state ${doc.status}`}>
          {statusLabels[doc.status]}
        </span>
        <button
          onClick={upload}
          disabled={["queued", "extracting"].includes(doc.status) || !current}
        >
          Upload revision
        </button>
      </div>
      {doc.status === "failed" && (
        <section className="failure">
          <h2>Extraction failed</h2>
          <p>{doc.error || "The document could not be extracted."}</p>
          {current && (
            <button disabled={retrying} onClick={() => void retry()}>
              {retrying ? "Retrying…" : "Retry extraction"}
            </button>
          )}
          {retryError && <p role="alert">{retryError}</p>}
        </section>
      )}
      {(doc.status === "queued" || doc.status === "extracting") && (
        <p className="notice" role="status">
          {doc.status === "queued"
            ? "Waiting for extraction to start."
            : "Extracting values and checking source passages."}{" "}
          This view updates automatically.
        </p>
      )}
      {doc.status === "extracted" && (
        <>
          <div className="review-header">
            <div>
              <h2>Field review</h2>
              <p>
                {progressText(doc.progress)}
                {doc.progress.pending > 0 &&
                  ` · ${doc.progress.pending} pending`}
              </p>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => setOnlyPending(e.target.checked)}
              />{" "}
              Pending only
            </label>
          </div>
          {fields.map((item) => (
            <ReviewField
              key={item.id}
              item={item}
              current={current}
              refresh={refresh}
            />
          ))}
          {!fields.length && (
            <p className="notice">
              {onlyPending
                ? "All fields have been reviewed."
                : "No extracted fields."}
            </p>
          )}
          {doc.parsedText && (
            <details className="parsed">
              <summary>View parsed text · v{doc.version}</summary>
              <pre>{doc.parsedText}</pre>
            </details>
          )}
        </>
      )}
    </>
  );
}

export default function Home() {
  const [selection, setSelection] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [modal, setModal] = useState<"upload" | "revision" | "ask" | null>(
    null,
  );
  const [change, setChange] = useState(0);
  const list = useResource<{ documents: DocumentSummary[] }>(
    "/documents",
    change,
  );
  const docs = list?.data?.documents;
  const id = selection ?? docs?.[0]?.id;
  const detail = useResource<DocumentDetail>(
    id
      ? `/documents/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`
      : null,
    change,
  );
  const doc = detail?.data;
  const refresh = () => setChange((n) => n + 1);
  function choose(id: string, n: number | null = null) {
    setSelection(id);
    setVersion(n);
  }
  function uploaded(id: string) {
    setModal(null);
    choose(id);
    refresh();
  }
  function connectionError(message: string) {
    return (
      <div role="alert" className="error">
        {message} <button onClick={refresh}>Retry connection</button>
      </div>
    );
  }

  return (
    <>
      <a className="skip" href="#document-detail">
        Skip to document review
      </a>
      <header className="mast">
        <div className="brand" aria-label="Lomi">
          <span aria-hidden="true" className="brand-mark" />
          Lomi
        </div>
        <span className="brand-area">Review workspace</span>
        <div className="mast-actions">
          <button onClick={() => setModal("ask")}>Ask documents</button>
          <button className="primary" onClick={() => setModal("upload")}>
            Upload PDFs
          </button>
        </div>
      </header>
      <main className="workspace">
        <aside className="library">
          <div className="library-heading">
            <h2>Documents</h2>
            {docs && <span>{docs.length}</span>}
          </div>
          {list?.error && connectionError(list.error)}
          {!docs && !list?.error && <p role="status">Loading documents…</p>}
          {!docs?.length && list?.data && (
            <p>Upload a PDF to start a review.</p>
          )}
          <nav aria-label="Document library">
            {docs?.map((item) => (
              <button
                key={item.id}
                className={`document-link ${item.id === id ? "selected" : ""}`}
                aria-current={item.id === id ? "page" : undefined}
                onClick={() => choose(item.id)}
              >
                <span className="file-meta">
                  {typeLabels[item.type]} <span>v{item.version}</span>
                </span>
                <strong>{item.title}</strong>
                <span className={`state ${item.status}`}>
                  {statusLabels[item.status]}
                </span>
                {item.status === "extracted" && (
                  <small>{progressText(item.progress)}</small>
                )}
              </button>
            ))}
          </nav>
        </aside>
        <section
          className="detail"
          id="document-detail"
          tabIndex={-1}
          aria-label="Document review"
        >
          {detail?.error && connectionError(detail.error)}
          {doc ? (
            <Detail
              key={`${id}/${doc.version}`}
              doc={doc}
              latest={Math.max(doc.version, ...doc.versions)}
              version={version}
              setVersion={setVersion}
              upload={() => setModal("revision")}
              refresh={refresh}
            />
          ) : (
            <div className="empty">
              <span aria-hidden="true" className="paper-icon" />
              <h1>{id ? "Opening document" : "Document review"}</h1>
              <p>
                {id
                  ? "Fetching the version and its evidence."
                  : "Select a document to review extracted values beside their source passages."}
              </p>
            </div>
          )}
        </section>
      </main>
      {(modal === "upload" || modal === "revision") && (
        <Upload
          documentId={modal === "revision" ? id : undefined}
          close={() => setModal(null)}
          done={uploaded}
        />
      )}
      {modal === "ask" && (
        <Ask
          close={() => setModal(null)}
          open={(sourceId, n) => {
            setModal(null);
            choose(sourceId, n);
          }}
          documentId={id}
          title={doc?.title}
        />
      )}
    </>
  );
}
