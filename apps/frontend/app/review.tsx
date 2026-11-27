import { useState, type FormEvent } from "react";
import type { ExtractedField, FieldReview } from "@repo/types/reviewer";
import { errorMessage, fieldLabel, post } from "./client";

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
  const [editing, setEditing] = useState(false);
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
        ...(action === "correct"
          ? { value: correction.trim(), note: note.trim() || undefined }
          : {}),
      });
      setEditing(false);
      refresh();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const corrected = item.review?.action === "correct";
  return (
    <article className="field">
      <div className="field-heading">
        <h3>{fieldLabel(item.field)}</h3>
        <span
          className={`review-state ${item.review ? "reviewed" : "pending"}`}
        >
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
        <div className="source">
          <p className="label">Source quote</p>
          {item.quote ? (
            <blockquote>{item.quote}</blockquote>
          ) : (
            <p className="muted">No verified passage.</p>
          )}
        </div>
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
      {current && !editing && (
        <div className="field-actions">
          {(!item.review || corrected) && (
            <button disabled={busy} onClick={() => void save("approve")}>
              {item.value === null ? "Confirm gap" : "Approve"}
            </button>
          )}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setCorrection(item.review?.value ?? item.value ?? "");
              setNote(item.review?.note ?? "");
              setEditing(true);
            }}
          >
            {corrected ? "Edit correction" : "Correct value"}
          </button>
        </div>
      )}
      {editing && current && (
        <form
          className="correction"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void save("correct");
          }}
        >
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
          <div className="field-actions">
            <button className="primary" disabled={busy || !correction.trim()}>
              Save correction
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
    </article>
  );
}
