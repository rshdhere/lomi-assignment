"use client";

import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import type {
  DocumentDetail,
  DocumentSummary,
  Progress,
} from "@repo/types/reviewer";
import { apiText, errorMessage, fieldLabel, post, typeLabels } from "../client";
import AnimatedList from "../ui/animated-list/AnimatedList";
import { Ask } from "../ask";
import { ReviewBounceDeck, ReviewField } from "../review";
import { Upload } from "../upload";
import { WorkspaceIcon } from "../workspace-icon";

const statusLabels = {
  queued: "Queued",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Failed",
};

function reviewedCount(progress: Progress) {
  return progress.approved + progress.corrected + progress.carriedOver;
}

function reviewPercentage(progress: Progress) {
  const reviewed = reviewedCount(progress);
  const total = reviewed + progress.pending;
  return total ? `${(reviewed / total) * 100}%` : "0%";
}

function progressText(progress: Progress) {
  const reviewed = reviewedCount(progress);
  return `${reviewed} of ${reviewed + progress.pending} reviewed`;
}

function renderDocument(item: DocumentSummary) {
  return (
    <>
      <strong>{item.title}</strong>
      <span className="file-meta">
        <span>
          <WorkspaceIcon name="document" />
          {typeLabels[item.type]}
        </span>
        <span>v{item.version}</span>
      </span>
      <span className="library-progress">
        <span className={`state ${item.status}`}>
          {statusLabels[item.status]}
        </span>
        {item.status === "extracted" && (
          <small>{progressText(item.progress)}</small>
        )}
      </span>
      {item.status === "extracted" && (
        <span className="library-meter" aria-hidden="true">
          <span style={{ width: reviewPercentage(item.progress) }} />
        </span>
      )}
    </>
  );
}

// A fresh request is scheduled after the previous one settles so slow responses cannot overlap.
function useResource<T>(
  path: string | null,
  change: number,
  retainPrevious = false,
) {
  const [result, setResult] = useState<{
    path: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let previousBody: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const body = await apiText(path!, { signal: controller.signal });
        if (!controller.signal.aborted && body !== previousBody) {
          const data: T = JSON.parse(body);
          previousBody = body;
          setResult({ path: path!, data });
        }
      } catch (error) {
        previousBody = undefined;
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
  return result?.path === path || (retainPrevious && path && result?.data)
    ? result
    : undefined;
}

function Detail({
  doc,
  latest,
  version,
  setVersion,
  upload,
  ask,
  refresh,
}: {
  doc: DocumentDetail;
  latest: number;
  version: number | null;
  setVersion: (n: number | null) => void;
  upload: () => void;
  ask: () => void;
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
    <div className="document-view">
      <header className="document-summary">
        <div className="summary-status">
          <span className="doc-kind">
            <WorkspaceIcon name="document" />
            {typeLabels[doc.type]}
          </span>
          <span className={`state ${doc.status}`}>
            {doc.extractionStatus === "extracted" &&
            doc.indexingStatus !== "ready"
              ? "Review ready · search " + doc.indexingStatus
              : statusLabels[doc.status]}
          </span>
        </div>
        <h2 className="document-title">{doc.title}</h2>
        <div className="doc-tools">
          <label className="version-label">
            Viewing
            <select
              aria-label="Document version"
              value={version === latest ? "" : (version ?? "")}
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
          <button type="button" className="ask-text" onClick={ask}>
            Ask documents
          </button>
          <button
            onClick={upload}
            disabled={
              ["queued", "extracting"].includes(
                doc.extractionStatus ?? doc.status,
              ) || !current
            }
          >
            <WorkspaceIcon name="upload" />
            Upload revision
          </button>
        </div>
      </header>
      {doc.status === "failed" && (
        <section className="failure">
          <h2>
            {doc.indexingStatus === "failed"
              ? "Search indexing failed"
              : "Extraction failed"}
          </h2>
          <p>{doc.error || "The document could not be extracted."}</p>
          {current && (
            <button disabled={retrying} onClick={() => void retry()}>
              {retrying ? "Retrying…" : "Retry extraction"}
            </button>
          )}
          {retryError && <p role="alert">{retryError}</p>}
        </section>
      )}
      {["queued", "extracting"].includes(
        doc.extractionStatus ?? doc.status,
      ) && (
        <p className="notice" role="status">
          {doc.status === "queued"
            ? "Waiting for extraction to start."
            : "Extracting values and checking source passages."}{" "}
          This view updates automatically.
        </p>
      )}
      {(doc.extractionStatus ?? doc.status) === "extracted" && (
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
          {fields.length > 0 && (
            <ReviewBounceDeck
              labels={fields.map((item) => fieldLabel(item.field))}
            >
              {fields.map((item) => (
                <ReviewField
                  key={item.id}
                  item={item}
                  current={current}
                  refresh={refresh}
                />
              ))}
            </ReviewBounceDeck>
          )}
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
    </div>
  );
}

export default function Home() {
  const [selection, setSelection] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [modal, setModal] = useState<"upload" | "revision" | "ask" | null>(
    null,
  );
  const [change, setChange] = useState(0);
  const [filter, setFilter] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const detailRegion = useRef<HTMLElement>(null);
  const list = useResource<{ documents: DocumentSummary[] }>(
    "/documents",
    change,
  );
  const docs = list?.data?.documents;
  const id = selection ?? docs?.[0]?.id;
  const detailPath = id
    ? `/documents/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`
    : null;
  const detail = useResource<DocumentDetail>(detailPath, change, true);
  const switching = !!detail && detail.path !== detailPath;
  const doc = detail?.data;
  const refresh = () => setChange((n) => n + 1);
  function choose(id: string, n: number | null = null) {
    setSelection(id);
    setVersion(n);
  }
  function openAsk() {
    setModal("ask");
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

  const query = filter.trim().toLowerCase();
  const visibleDocs = useMemo(
    () =>
      query
        ? docs?.filter((item) =>
            `${item.title} ${typeLabels[item.type]}`
              .toLowerCase()
              .includes(query),
          )
        : docs,
    [docs, query],
  );
  const selectDocument = useCallback(
    (item: DocumentSummary) => {
      setSelection(item.id);
      setVersion(null);
      if (libraryOpen) detailRegion.current?.focus({ preventScroll: true });
      setLibraryOpen(false);
    },
    [libraryOpen],
  );
  return (
    <>
      <a className="skip" href="#document-detail">
        Skip to document review
      </a>
      <header className="mast">
        <div className="mast-inner">
          <span className="mast-logo" role="img" aria-label="Lomi Labs" />
          <nav className="mast-actions" aria-label="Workspace actions">
            <button
              type="button"
              className="primary upload-action"
              onClick={() => setModal("upload")}
            >
              Upload
              <span className="upload-disc">
                <WorkspaceIcon name="uploadFile" />
              </span>
            </button>
          </nav>
        </div>
      </header>
      <main
        className="workspace"
        id="workspace"
        aria-label="Document review workspace"
      >
        <div className="workspace-grid">
          <aside className={`library${libraryOpen ? " expanded" : ""}`}>
            <div className="library-heading">
              <h2>
                <WorkspaceIcon name="folder" />
                Documents
              </h2>
              {docs && (
                <span className="library-count">
                  {query
                    ? `${visibleDocs?.length} of ${docs.length}`
                    : docs.length}
                </span>
              )}
              <button
                className="library-toggle"
                type="button"
                aria-controls="library-content"
                aria-expanded={libraryOpen}
                onClick={() => setLibraryOpen(!libraryOpen)}
              >
                {libraryOpen ? "Hide" : "Browse"}
                <WorkspaceIcon name="chevron" />
              </button>
            </div>
            <div className="library-content" id="library-content">
              {list?.error && connectionError(list.error)}
              {!docs && !list?.error && (
                <p className="library-message" role="status">
                  Loading documents…
                </p>
              )}
              {!docs?.length && list?.data && (
                <p className="library-message">
                  Uploaded PDFs will appear here.
                </p>
              )}
              {Boolean(docs?.length) && (
                <label className="library-search">
                  <WorkspaceIcon name="search" />
                  <input
                    type="search"
                    aria-label="Find a document"
                    placeholder="Find a document"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
              )}
              <nav aria-label="Document library">
                {visibleDocs && visibleDocs.length > 0 && (
                  <AnimatedList
                    items={visibleDocs}
                    selectedIndex={visibleDocs.findIndex(
                      (item) => item.id === id,
                    )}
                    theme="light"
                    animation="pop"
                    animateOnce
                    frame={false}
                    selectOnHover={false}
                    accentColor="#4189d6"
                    width="100%"
                    maxHeight="min(65svh, 42rem)"
                    fadeSize={16}
                    itemClassName="document-link"
                    onItemSelect={selectDocument}
                    renderItem={renderDocument}
                  />
                )}
              </nav>
              {docs?.length && visibleDocs?.length === 0 ? (
                <p className="library-message" role="status">
                  No matching documents.
                </p>
              ) : null}
            </div>
          </aside>
          <section
            className="detail"
            id="document-detail"
            ref={detailRegion}
            tabIndex={-1}
            aria-label="Document review"
          >
            {!switching && detail?.error && connectionError(detail.error)}
            {doc ? (
              <div inert={switching} aria-busy={switching}>
                <Detail
                  key={`${doc.id}/${doc.version}`}
                  doc={doc}
                  latest={Math.max(doc.version, ...doc.versions)}
                  version={version}
                  setVersion={setVersion}
                  upload={() => setModal("revision")}
                  ask={openAsk}
                  refresh={refresh}
                />
              </div>
            ) : !detail?.error ? (
              <div className="empty">
                <span className="empty-icon" aria-hidden="true">
                  <WorkspaceIcon name="document" />
                </span>
                <h2>
                  {id
                    ? "Opening document"
                    : !list?.data || list.error
                      ? "Document library"
                      : "Upload your first PDF"}
                </h2>
                <p>
                  {id
                    ? "Fetching the version and its evidence."
                    : list?.error
                      ? "Reconnect to load your documents."
                      : !list?.data
                        ? "Loading your workspace…"
                        : "Add a document to start reviewing its extracted values and source passages."}
                </p>
                {docs?.length === 0 && !list?.error && (
                  <button
                    className="primary"
                    onClick={() => setModal("upload")}
                  >
                    <WorkspaceIcon name="upload" />
                    Choose PDFs
                  </button>
                )}
                {list?.error && !docs && (
                  <button onClick={refresh}>Retry loading documents</button>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </main>
      {(modal === "upload" || modal === "revision") && (
        <Upload
          documentId={modal === "revision" ? id : undefined}
          expectedVersion={modal === "revision" ? doc?.version : undefined}
          close={() => setModal(null)}
          done={uploaded}
        />
      )}
      <Ask
        visible={modal === "ask"}
        close={() => setModal(null)}
        open={(sourceId, n) => {
          setModal(null);
          choose(sourceId, n);
        }}
        documentId={switching ? undefined : id}
        title={switching ? undefined : doc?.title}
      />
    </>
  );
}
