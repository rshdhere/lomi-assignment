"use client";

import { useEffect, useRef, useState } from "react";
import type {
  DocumentDetail,
  DocumentSummary,
  Progress,
} from "@repo/types/reviewer";
import { api, errorMessage, post, typeLabels } from "./client";
import { Ask } from "./ask";
import { ReviewField } from "./review";
import { Upload } from "./upload";
import { WorkspaceIcon } from "./workspace-icon";

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
      <header className="document-summary">
        <div className="summary-status">
          <span className="doc-kind">
            <WorkspaceIcon name="document" />
            {typeLabels[doc.type]}
          </span>
          <span className={`state ${doc.status}`}>
            {statusLabels[doc.status]}
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
          <button
            onClick={upload}
            disabled={["queued", "extracting"].includes(doc.status) || !current}
          >
            <WorkspaceIcon name="upload" />
            Upload revision
          </button>
        </div>
      </header>
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
  const [filter, setFilter] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const actionsToggle = useRef<HTMLButtonElement>(null);
  const detailRegion = useRef<HTMLElement>(null);
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

  useEffect(() => {
    if (!actionsOpen) return;
    function dismissOutside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !actions.current?.contains(event.target)
      )
        setActionsOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActionsOpen(false);
        actionsToggle.current?.focus();
      }
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [actionsOpen]);
  function openAction(which: "ask" | "upload") {
    if (actionsOpen) actionsToggle.current?.focus();
    setActionsOpen(false);
    setModal(which);
  }
  const query = filter.trim().toLowerCase();
  const visibleDocs = docs?.filter((item) =>
    `${item.title} ${typeLabels[item.type]}`.toLowerCase().includes(query),
  );
  return (
    <>
      <a className="skip" href="#document-detail">
        Skip to document review
      </a>
      <header className="mast">
        <div className="mast-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Lomi Labs
          </div>
          <div
            className="action-nav"
            ref={actions}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setActionsOpen(false);
            }}
          >
            <button
              type="button"
              className="actions-toggle"
              aria-controls="workspace-actions"
              aria-expanded={actionsOpen}
              ref={actionsToggle}
              onClick={() => setActionsOpen(!actionsOpen)}
            >
              <WorkspaceIcon name={actionsOpen ? "close" : "menu"} />
              Actions
            </button>
            <div
              id="workspace-actions"
              className={`mast-actions${actionsOpen ? " open" : ""}`}
            >
              <button onClick={() => openAction("ask")}>
                <WorkspaceIcon name="ask" />
                Ask documents
              </button>
              <button
                className="primary upload-action"
                onClick={() => openAction("upload")}
              >
                Upload PDFs
                <span className="mint-disc">
                  <WorkspaceIcon name="plus" />
                </span>
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="workspace" id="workspace">
        <header className="workspace-intro">
          <div className="intro-copy">
            <h1>Review workspace</h1>
            <p>
              Check extracted values against their source passages. Approve the
              evidence or record a correction.
            </p>
          </div>
          <div className="folio-art" aria-hidden="true">
            <span className="contour contour-outer" />
            <span className="contour contour-middle" />
            <span className="contour contour-inner" />
            <div className="folio">
              <i className="sheet sheet-back" />
              <i className="sheet sheet-middle" />
              <i className="sheet sheet-front">
                <b />
                <b />
                <b />
                <b />
              </i>
            </div>
          </div>
        </header>
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
                {visibleDocs?.map((item) => (
                  <button
                    key={item.id}
                    className={`document-link ${item.id === id ? "selected" : ""}`}
                    aria-current={item.id === id ? "page" : undefined}
                    onClick={() => {
                      choose(item.id);
                      if (libraryOpen)
                        detailRegion.current?.focus({ preventScroll: true });
                      setLibraryOpen(false);
                    }}
                  >
                    <span className="file-meta">
                      <span>
                        <WorkspaceIcon name="document" />
                        {typeLabels[item.type]}
                      </span>
                      <span>v{item.version}</span>
                    </span>
                    <strong>{item.title}</strong>
                    <span className="library-progress">
                      <span className={`state ${item.status}`}>
                        {statusLabels[item.status]}
                      </span>
                      {item.status === "extracted" && (
                        <small>{progressText(item.progress)}</small>
                      )}
                    </span>
                  </button>
                ))}
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
