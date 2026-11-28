import type { DocumentSummary } from "@repo/types/reviewer";
import { Card } from "../components/dashboard/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../components/dashboard/table";
import { typeLabels } from "../client";
import { Analytics } from "./analytics";
import { WorkspaceIcon } from "../workspace-icon";
import { IconFiles } from "@tabler/icons-react";

export function Overview({
  docs,
  mode,
  open,
  search,
  setSearch,
  status,
  setStatus,
}: {
  docs: DocumentSummary[];
  mode: "overview" | "queue" | "failures";
  open: (id: string) => void;
  search: string;
  setSearch: (value: string) => void;
  status: DocumentSummary["status"] | null;
  setStatus: (value: DocumentSummary["status"] | null) => void;
}) {
  const queue = mode === "queue";
  const failures = mode === "failures";
  const reviewed = (d: DocumentSummary) =>
    d.progress.approved + d.progress.corrected + d.progress.carriedOver;
  const complete = docs.reduce((sum, d) => sum + reviewed(d), 0);
  const pending = docs.reduce((sum, d) => sum + d.progress.pending, 0);
  const next = docs.find(
    (d) => d.status === "extracted" && d.progress.pending > 0,
  );
  const rows = queue
    ? docs
        .filter((d) => d.status === "extracted" && d.progress.pending > 0)
        .sort((a, b) => b.progress.pending - a.progress.pending)
    : failures
      ? docs.filter((d) => d.status === "failed")
      : docs;
  const matches = rows.filter(
    (d) =>
      (mode !== "overview" || !status || d.status === status) &&
      (d.title + " " + typeLabels[d.type] + " v" + d.version + " " + d.status)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <>
      <div className={mode === "overview" ? "overview-banner" : "dash-intro"}>
        <h1>
          {failures
            ? "Failed extractions"
            : queue
              ? "Review queue"
              : "Workspace overview"}
        </h1>
        {mode === "overview" && (
          <p>
            {pending ? (
              <>
                <strong>{pending} fields</strong> awaiting review
              </>
            ) : (
              "No fields awaiting review"
            )}{" "}
            · {docs.length} {docs.length === 1 ? "document" : "documents"}
          </p>
        )}
        {mode === "overview" && next && (
          <div className="mast-actions">
            <button
              type="button"
              className="primary upload-action"
              onClick={() => open(next.id)}
            >
              Continue review{" "}
              <span className="upload-disc" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        )}
      </div>
      {mode === "overview" && (
        <Analytics
          docs={docs}
          reviewed={complete}
          pending={pending}
          status={status}
          selectStatus={setStatus}
        />
      )}
      <Card
        className="dash-library"
        style={mode !== "overview" ? { marginTop: "1.4rem" } : undefined}
      >
        <div className="dash-library-heading">
          <div className="library-title-block">
            <h2>
              {failures
                ? "Documents to retry"
                : queue
                  ? "Documents awaiting review"
                  : "Document library"}
            </h2>
            <span className="library-count-badge">
              {matches.length} {matches.length === 1 ? "document" : "documents"}
            </span>
          </div>
          {mode === "overview" && status && (
            <button className="pipeline-reset" onClick={() => setStatus(null)}>
              Clear {status} filter ×
            </button>
          )}
          <label className="library-search">
            <WorkspaceIcon name="search" />
            <input
              type="search"
              aria-label="Find a document"
              placeholder="Find a document"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <Table aria-label="Document library">
          <TableHeader>
            <TableRow>
              {["Document", "Status", "Review progress"].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <button className="dash-doc" onClick={() => open(d.id)}>
                    <span className="dash-file-icon">
                      <IconFiles size={19} stroke={1.7} aria-hidden="true" />
                    </span>
                    <span>
                      {d.title}
                      <small>
                        {typeLabels[d.type]} · v{d.version}
                      </small>
                    </span>
                  </button>
                </TableCell>
                <TableCell>
                  <span className={`state ${d.status}`}>{d.status}</span>
                </TableCell>
                <TableCell>
                  {d.status === "extracted" ? (
                    <>
                      <small>
                        {reviewed(d)} of {reviewed(d) + d.progress.pending}{" "}
                        reviewed
                      </small>
                      <progress
                        aria-label={`${d.title} review progress`}
                        value={reviewed(d)}
                        max={reviewed(d) + d.progress.pending || 1}
                      />
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {matches.length === 0 && (
          <p className="library-message">
            {failures && !rows.length
              ? "No failed extractions."
              : queue && !rows.length
                ? "No documents are awaiting review."
                : docs.length
                  ? "No matching documents."
                  : "Upload a PDF to start your first review."}
          </p>
        )}
      </Card>
    </>
  );
}
