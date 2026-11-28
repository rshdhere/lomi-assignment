import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QueryResult } from "@repo/types/reviewer";
import { errorMessage, fieldLabel, post } from "./client";
import { Button } from "./ui/button";
import { WorkspaceIcon } from "./workspace-icon";
import { Modal } from "./modal";

interface ChatTurn {
  question: string;
  answer?: QueryResult;
  error?: string;
}

export function Ask({
  visible,
  close,
  open,
  documentId,
  title,
}: {
  visible: boolean;
  close: () => void;
  open: (id: string, version: number) => void;
  documentId?: string;
  title?: string;
}) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const latest = turns.at(-1);
  const busy = !!latest && !latest.answer && latest.error === undefined;
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible && thread.current)
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [visible, turns.length]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (busy || !text) return;
    setTurns((old) => [...old, { question: text }]);
    setQuestion("");
    let result: ChatTurn;
    try {
      const answer = await post<QueryResult>("/query", {
        question: text,
        ...(scope && documentId ? { documentId } : {}),
      });
      result = { question: text, answer };
    } catch (err) {
      result = { question: text, error: errorMessage(err) };
    }
    setTurns((old) => [...old.slice(0, -1), result]);
  }
  if (!visible) return null;
  return (
    <Modal title="Ask your documents" close={close} side>
      <label className="control ask-scope">
        Search in
        <select
          value={scope && documentId ? "current" : ""}
          onChange={(e) => setScope(e.target.value)}
          disabled={busy}
        >
          <option value="">All documents</option>
          {documentId && <option value="current">{title}</option>}
        </select>
      </label>
      <div className="ask-thread" ref={thread}>
        {!turns.length && (
          <div className="ask-prompt">
            <span className="ask-logo" role="img" aria-label="Lomi Labs" />
            <p>Ask a question about your documents</p>
          </div>
        )}
        {turns.map(({ question: sent, answer, error }, index) => (
          <article key={index} className="chat-turn">
            <p className="chat-question" aria-label="Your question">
              {sent}
            </p>
            {!answer && error === undefined && (
              <p role="status" className="chat-generating">
                Searching your documents<span aria-hidden="true">…</span>
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {answer && (
              <section aria-live="polite" className="query-answer">
                <h3>Answer</h3>
                <p className="answer-text">
                  {answer.sources.reduce(
                    (text, source, i) =>
                      text.replaceAll(`[${source.id}]`, `[${i + 1}]`),
                    answer.answer,
                  )}
                </p>
                {answer.sources.length > 0 && (
                  <>
                    <h3 className="sources-heading">Sources</h3>
                    <ol className="citation-list" role="list">
                      {answer.sources.map((source, i) => (
                        <li key={source.id}>
                          <button
                            type="button"
                            className="citation-link"
                            onClick={() =>
                              open(source.documentId, source.version)
                            }
                          >
                            <span
                              aria-hidden="true"
                              className="citation-number"
                            >
                              [{i + 1}]
                            </span>
                            <span>
                              {source.title} · v{source.version}
                            </span>
                            <span aria-hidden="true" className="citation-arrow">
                              ↗
                            </span>
                          </button>
                          {source.value && (
                            <p className="citation-value">{source.value}</p>
                          )}
                          {source.quote && (
                            <blockquote>{source.quote}</blockquote>
                          )}
                          <small className="citation-meta">
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
          </article>
        ))}
      </div>
      <form onSubmit={ask} className="ask-composer" aria-busy={busy}>
        <textarea
          aria-label="Question"
          required
          maxLength={2000}
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          enterKeyHint="send"
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            if (!event.repeat && !busy && question.trim()) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="What would you like to know?"
          disabled={busy}
        />
        <Button
          className="ask-send"
          aria-label={busy ? "Searching…" : "Ask question"}
          title="Ask question"
          disabled={busy || !question.trim()}
        >
          <WorkspaceIcon name="send" />
        </Button>
      </form>
    </Modal>
  );
}
