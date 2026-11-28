import { useState, type FormEvent } from "react";
import type { ExtractedField, FieldReview } from "@repo/types/reviewer";
import { errorMessage, fieldLabel, post } from "./client";
import { Button } from "./ui/button";
import { Modal } from "./modal";
import "./review.css";

function reviewText(review: FieldReview | null) {
  if (!review) return "Pending";
  return review.action === "approve" ? "Approved" : "Corrected";
}

export function ReviewField({
  item,
  current,
  refresh,
}: {
  item: ExtractedField;
  current: boolean;
  refresh: () => void;
}) {
  const [editRevision, setEditRevision] = useState<number>();
  const [editing, setEditing] = useState<"approve" | "correct" | null>(null);
  const [correction, setCorrection] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(action: "approve" | "correct") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await post(`/values/${encodeURIComponent(item.id)}/review`, {
        action,
        expectedRevision:
          action === "correct" ? editRevision : item.reviewRevision,
        ...(action === "correct"
          ? { value: correction.trim(), note: note.trim() || undefined }
          : {}),
      });
      setEditing(null);
      refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const corrected = item.review?.action === "correct";
  return (
    <article className="field" aria-labelledby={`field-${item.id}`}>
      <div className="field-heading">
        <h3 id={`field-${item.id}`}>{fieldLabel(item.field)}</h3>
        <span
          className={`review-state ${item.review ? "reviewed" : "pending"}`}
        >
          <span className="review-indicator" aria-hidden="true" />
          {item.carriedOver && "Carried over · "}
          {reviewText(item.review)}
        </span>
      </div>
      <div className="evidence-pair">
        <div>
          <p className="label">
            {corrected ? "Corrected value" : "Extracted value"}
          </p>
          <p className="field-value">
            {corrected ? item.review?.value : (item.value ?? "Gap")}
          </p>
          {corrected && (
            <p className="muted">Extracted as {item.value ?? "a gap"}</p>
          )}
          {item.reason && <p className="gap">Gap · {item.reason}</p>}
          {item.review?.note && (
            <p className="review-note">Review note: {item.review.note}</p>
          )}
        </div>
        <figure className="source">
          <figcaption className="label">
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
            >
              <path
                d="M2.5 8.5c0-2.2.8-3.7 2.8-4.8m-2.8 4.8h4.2v4H2.5v-4Zm7 0c0-2.2.8-3.7 2.8-4.8m-2.8 4.8h4.2v4H9.5v-4Z"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
            </svg>
            Source quote
          </figcaption>
          {item.quote ? (
            <blockquote>{item.quote}</blockquote>
          ) : (
            <p className="muted">No verified passage.</p>
          )}
        </figure>
      </div>
      {item.previous && !item.carriedOver && (
        <div className="previous">
          <strong>Previous version</strong>
          <p>
            {item.previous.value ?? "Gap"} · {reviewText(item.previous.review)}
            {item.previous.review?.action === "correct" &&
              ` to ${item.previous.review.value}`}
          </p>
          {item.previous.review?.note && (
            <small>{item.previous.review.note}</small>
          )}
          {item.previous.quote && (
            <blockquote>{item.previous.quote}</blockquote>
          )}
        </div>
      )}
      {current && (
        <div className="field-actions">
          {(!item.review || corrected) && (
            <button
              className="approve-field"
              disabled={busy}
              onClick={() => {
                setMessage("");
                setEditing("approve");
              }}
            >
              <span className="action-check" aria-hidden="true" />
              {item.value === null ? "Confirm gap" : "Approve"}
            </button>
          )}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setCorrection(item.review?.value ?? item.value ?? "");
              setNote(item.review?.note ?? "");
              setMessage("");
              setEditRevision(item.reviewRevision);
              setEditing("correct");
            }}
          >
            {corrected ? "Edit correction" : "Correct value"}
          </button>
        </div>
      )}
      {editing && current && (
        <Modal
          title={
            editing === "correct"
              ? `Correct ${fieldLabel(item.field)}?`
              : `Approve ${fieldLabel(item.field)}?`
          }
          close={() => setEditing(null)}
          busy={busy}
        >
          <form
            className="correction"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void save(editing);
            }}
          >
            <p>{item.value ?? item.reason ?? "Gap"}</p>
            {item.quote && (
              <blockquote className="source">{item.quote}</blockquote>
            )}
            {editing === "correct" && (
              <>
                <label className="control">
                  Corrected value
                  <input
                    required
                    value={correction}
                    onChange={(e) => setCorrection(e.target.value)}
                    maxLength={4000}
                  />
                </label>
                <label className="control">
                  Note (optional)
                  <textarea
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                  />
                </label>
              </>
            )}
            {message && (
              <p className="error" role="alert">
                {message}
              </p>
            )}
            <div className="field-actions">
              <Button
                variant="default"
                disabled={busy || (editing === "correct" && !correction.trim())}
              >
                {editing === "correct" ? "Save correction" : "Confirm approval"}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </article>
  );
}
