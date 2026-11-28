"use client";

import {
  useSyncExternalStore,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  DocumentDetail,
  DocumentSummary,
  Progress,
} from "@repo/types/reviewer";
import { apiText, errorMessage, fieldLabel, post, typeLabels } from "../client";
import { Ask } from "../ask";
import { ReviewBounceDeck, ReviewField } from "../review";
import { Upload } from "../upload";
import { WorkspaceIcon } from "../workspace-icon";
import {
  Sidebar,
  DesktopSidebar,
  MobileSidebar,
} from "../components/ui/sidebar";
import { HugeiconsIcon } from "@hugeicons/react";
import { IconPlus } from "@tabler/icons-react";
import {
  Alert02Icon,
  BookOpen01Icon,
  FileEditIcon,
  Home03Icon,
  MessageQuestionIcon,
  Settings01Icon,
  Task01Icon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { Overview } from "./overview";
import "./dashboard.css";

const statusLabels = {
  queued: "Queued",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Failed",
};

function reviewedCount(progress: Progress) {
  return progress.approved + progress.corrected + progress.carriedOver;
}

function progressText(progress: Progress) {
  const reviewed = reviewedCount(progress);
  return `${reviewed} of ${reviewed + progress.pending} reviewed`;
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

const viewTitles = {
  overview: "Overview",
  review: "Field review",
  queue: "Review queue",
  settings: "Settings",
  failures: "Failed extractions",
  guide: "Review guide",
} as const;
const preferenceKey = "lomi.workspace.sidebar";
let sessionPreferences = "00";
function readPreferences() {
  try {
    return localStorage.getItem(preferenceKey) ?? sessionPreferences;
  } catch {
    return sessionPreferences;
  }
}
function subscribePreferences(refresh: () => void) {
  window.addEventListener("storage", refresh);
  window.addEventListener(preferenceKey, refresh);
  return () => {
    window.removeEventListener("storage", refresh);
    window.removeEventListener(preferenceKey, refresh);
  };
}
export default function Home() {
  const [selection, setSelection] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [modal, setModal] = useState<"upload" | "revision" | "ask" | null>(
    null,
  );
  const [change, setChange] = useState(0);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<keyof typeof viewTitles>("overview");
  const [backView, setBackView] =
    useState<Exclude<keyof typeof viewTitles, "review">>("overview");
  const [status, setStatus] = useState<DocumentSummary["status"] | null>(null);
  const flags = useSyncExternalStore(
    subscribePreferences,
    readPreferences,
    () => "00",
  );
  const pinned = flags[0] === "1";
  function setPinned(value: boolean) {
    sessionPreferences = value ? "1" : "0";
    try {
      localStorage.setItem(preferenceKey, sessionPreferences);
    } catch {
      /* Session-only storage. */
    }
    window.dispatchEvent(new Event(preferenceKey));
  }
  const [railOpen, setRailOpen] = useState(false);
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
    if (view !== "review") setBackView(view);
    setView("review");
    setLibraryOpen(false);
    setSelection(id);
    setVersion(n);
  }
  function openAsk() {
    setRailOpen(false);
    setLibraryOpen(false);
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

  function navigate(destination: keyof typeof viewTitles) {
    if (destination === "review" && view !== "review") setBackView(view);
    setView(destination);
    if (destination !== "review") {
      setFilter("");
      setStatus(null);
    }
    setLibraryOpen(false);
  }
  function navItem(
    destination: keyof typeof viewTitles,
    icon: ReactNode,
    count?: number,
  ) {
    const label = viewTitles[destination];
    return (
      <button
        aria-label={label}
        title={label}
        aria-current={view === destination ? "page" : undefined}
        onClick={() => navigate(destination)}
      >
        {icon}
        <span className="dash-label">{label}</span>
        {!!count && <span className="dash-label dash-count">{count}</span>}
      </button>
    );
  }
  const railExpanded = modal !== "ask" && (railOpen || pinned);
  const navigation = (
    <>
      <Link className="dash-brand" aria-label="Lomi Labs" href="/">
        <span className="mast-logo" aria-hidden="true" />
        <span className="dash-label">Lomi Labs</span>
      </Link>
      <div className="dash-nav">
        <h2>Workspace</h2>
        <nav aria-label="Workspace navigation">
          {navItem(
            "overview",
            <HugeiconsIcon icon={Home03Icon} size={20} strokeWidth={1.8} />,
          )}
          {navItem(
            "queue",
            <HugeiconsIcon icon={Task01Icon} size={20} strokeWidth={1.8} />,
            docs?.filter(
              (d) => d.status === "extracted" && d.progress.pending > 0,
            ).length,
          )}
          {navItem(
            "review",
            <HugeiconsIcon icon={FileEditIcon} size={20} strokeWidth={1.8} />,
          )}
          <button
            aria-label="Ask documents"
            title="Ask documents"
            onClick={openAsk}
          >
            <HugeiconsIcon
              icon={MessageQuestionIcon}
              size={20}
              strokeWidth={1.8}
            />
            <span className="dash-label">Ask documents</span>
          </button>
        </nav>
        <h2>Document operations</h2>
        <nav aria-label="Document operations">
          <button
            aria-label="Upload documents"
            title="Upload documents"
            onClick={() => {
              setLibraryOpen(false);
              setModal("upload");
            }}
          >
            <HugeiconsIcon icon={Upload04Icon} size={20} strokeWidth={1.8} />
            <span className="dash-label">Upload documents</span>
          </button>
          {navItem(
            "failures",
            <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.8} />,
            docs?.filter((d) => d.status === "failed").length,
          )}
        </nav>
        <h2 className="dash-support-heading">Preferences and help</h2>
        <nav aria-label="Preferences and help">
          {navItem(
            "settings",
            <HugeiconsIcon icon={Settings01Icon} size={20} strokeWidth={1.8} />,
          )}
          {navItem(
            "guide",
            <HugeiconsIcon icon={BookOpen01Icon} size={20} strokeWidth={1.8} />,
          )}
        </nav>
      </div>
    </>
  );
  return (
    <>
      <a className="skip" href="#document-detail">
        Skip to document review
      </a>
      <main
        className="workspace dashboard-shell"
        id="workspace"
        aria-label="Document review workspace"
      >
        <aside className="dash-sidebar" aria-label="Workspace sidebar">
          <Sidebar open={railExpanded} setOpen={setRailOpen}>
            <DesktopSidebar
              className="dash-rail"
              data-expanded={railExpanded}
              onFocusCapture={() => setRailOpen(true)}
              onBlurCapture={(e) => {
                if (
                  !e.currentTarget.contains(e.relatedTarget) &&
                  !e.currentTarget.matches(":hover")
                )
                  setRailOpen(false);
              }}
              onMouseLeave={(e) => {
                if (!e.currentTarget.contains(document.activeElement))
                  setRailOpen(false);
              }}
            >
              {navigation}
            </DesktopSidebar>
          </Sidebar>
          <Sidebar open={libraryOpen} setOpen={setLibraryOpen}>
            <MobileSidebar className="dash-drawer">{navigation}</MobileSidebar>
          </Sidebar>
        </aside>
        <div className="dash-inset">
          <header className="dash-toolbar">
            <span>
              Workspace <b aria-hidden="true">/</b> {viewTitles[view]}
            </span>
            <nav className="mast-actions" aria-label="Workspace actions">
              <button
                type="button"
                className="primary upload-action"
                onClick={() => setModal("upload")}
              >
                Upload PDFs
                <IconPlus
                  className="upload-plus"
                  size={17}
                  stroke={2.25}
                  aria-hidden="true"
                />
              </button>
            </nav>
          </header>
          <section
            className="detail"
            id="document-detail"
            ref={detailRegion}
            tabIndex={-1}
            aria-label="Document review"
          >
            {view === "guide" ? (
              <>
                <div className="dash-intro">
                  <h1>Review guide</h1>
                </div>
                <section className="dash-preferences dash-guide">
                  <h2>Verify extracted fields</h2>
                  <p>
                    Open a document from the review queue. Compare each
                    extracted value with its source quote, then approve it or
                    enter a correction.
                  </p>
                  <button onClick={() => navigate("queue")}>
                    Open review queue
                  </button>
                  <h2>Review a revised PDF</h2>
                  <p>
                    Open the document and choose Upload revision. Check pending
                    fields for changes and use the version selector to inspect
                    earlier evidence.
                  </p>
                  <h2>Recover a failed extraction</h2>
                  <p>
                    Open the failed document to read its error and retry the
                    extraction.
                  </p>
                  <button onClick={() => navigate("failures")}>
                    View failed extractions
                  </button>
                </section>
              </>
            ) : view === "settings" ? (
              <>
                <div className="dash-intro">
                  <h1>Settings</h1>
                </div>
                <section className="dash-preferences">
                  <h2>Sidebar preferences</h2>
                  <p>Applies to this browser.</p>
                  <label>
                    <span>Keep the desktop sidebar expanded</span>
                    <input
                      type="checkbox"
                      checked={pinned}
                      onChange={(e) => setPinned(e.target.checked)}
                    />
                  </label>
                </section>
              </>
            ) : view === "overview" ||
              view === "queue" ||
              view === "failures" ? (
              docs ? (
                <Overview
                  mode={view}
                  docs={docs}
                  open={choose}
                  search={filter}
                  setSearch={setFilter}
                  status={status}
                  setStatus={setStatus}
                />
              ) : list?.error ? (
                connectionError(list.error)
              ) : (
                <p role="status">Loading workspace…</p>
              )
            ) : (
              <>
                <button
                  type="button"
                  className="review-back"
                  onClick={() => setView(backView)}
                >
                  <span aria-hidden="true">←</span> Back to{" "}
                  {viewTitles[backView].toLowerCase()}
                </button>
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
              </>
            )}
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
