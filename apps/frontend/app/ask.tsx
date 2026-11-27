import { useState, type FormEvent } from "react";
import type { QueryResult } from "@repo/types/reviewer";
import { errorMessage, fieldLabel, post } from "./client";
import { Modal } from "./modal";

export function Ask({
  close,
  open,
  documentId,
  title,
}: {
  close: () => void;
  open: (id: string, version: number) => void;
  documentId?: string;
  title?: string;
}) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<QueryResult>();
  const [error, setError] = useState("");
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true);
    setAnswer(undefined);
    setError("");
    try {
      setAnswer(
        await post<QueryResult>("/query", {
          question: question.trim(),
          ...(scope ? { documentId: scope } : {}),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Ask your documents" close={close}>
      <form onSubmit={ask}>
        <label className="control">
          Search in
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={busy}
          >
            <option value="">All documents</option>
            {documentId && <option value={documentId}>{title}</option>}
          </select>
        </label>
        <label className="control">
          Question
          <textarea
            required
            maxLength={2000}
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What is the total due on the invoice?"
            disabled={busy}
          />
        </label>
        <button className="primary" disabled={busy || !question.trim()}>
          {busy ? "Searching…" : "Ask question"}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {answer && (
        <section aria-live="polite" className="answer">
          <h3>Answer</h3>
          <p>
            {answer.sources.reduce(
              (text, source, i) =>
                text.replaceAll(`[${source.id}]`, `[${i + 1}]`),
              answer.answer,
            )}
          </p>
          {answer.sources.length > 0 && (
            <>
              <h3>Sources</h3>
              <ol>
                {answer.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      className="text-button"
                      onClick={() => open(source.documentId, source.version)}
                    >
                      {source.title} · v{source.version}
                    </button>
                    {source.value && <p>{source.value}</p>}
                    {source.quote && <blockquote>{source.quote}</blockquote>}
                    <small>
                      {source.field && fieldLabel(source.field) + " · "}
                      {source.reviewed ? "Reviewed" : "Unreviewed"}
                    </small>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </Modal>
  );
}
