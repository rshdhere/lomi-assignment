import {
  Children,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ExtractedField, FieldReview } from "@repo/types/reviewer";
import { errorMessage, fieldLabel, post } from "./client";
import { Button } from "./ui/button";
import { Modal } from "./modal";
import "./review.css";

function reviewText(review: FieldReview | null) {
  if (!review) return "Pending";
  return review.action === "approve" ? "Approved" : "Corrected";
}

export function ReviewBounceDeck({
  labels,
  children,
}: {
  labels: string[];
  children: ReactNode;
}) {
  const cards = Children.toArray(children);
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const tabsRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const navItemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(Math.floor((labels.length - 1) / 2));
  const [engaged, setEngaged] = useState(false);
  const [height, setHeight] = useState(280);
  const [deckWidth, setDeckWidth] = useState(980);
  const selectedIndex = Math.min(active, Math.max(0, labels.length - 1));

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const measure = () => {
      const next = Math.max(
        280,
        ...cardRefs.current.map((card) => card?.offsetHeight ?? 0),
      );
      setHeight(next + 36);
      setDeckWidth(deck.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(deck);
    cardRefs.current.forEach((card) => card && observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, [cards.length]);

  useEffect(() => {
    const tabs = tabsRef.current;
    const indicator = indicatorRef.current;
    const item = navItemsRef.current[selectedIndex];
    if (!tabs || !indicator || !item) return;
    const moveIndicator = () => {
      indicator.style.width = `${item.offsetWidth}px`;
      indicator.style.height = `${item.offsetHeight}px`;
      indicator.style.transform = `translate3d(${item.offsetLeft}px, ${item.offsetTop}px, 0)`;
    };
    const place = () => {
      const itemLeft = item.offsetLeft;
      const itemRight = itemLeft + item.offsetWidth;
      if (itemLeft < tabs.scrollLeft) {
        tabs.scrollTo({ left: itemLeft - 8, behavior: "smooth" });
      } else if (itemRight > tabs.scrollLeft + tabs.clientWidth) {
        tabs.scrollTo({
          left: itemRight - tabs.clientWidth + 8,
          behavior: "smooth",
        });
      }
      moveIndicator();
    };
    place();
    const observer = new ResizeObserver(moveIndicator);
    observer.observe(tabs);
    observer.observe(item);
    tabs.addEventListener("scroll", moveIndicator, { passive: true });
    return () => {
      observer.disconnect();
      tabs.removeEventListener("scroll", moveIndicator);
    };
  }, [selectedIndex, labels.length]);

  return (
    <div className="review-deck-wrap">
      <div
        ref={deckRef}
        className="review-deck"
        style={{ height }}
        onPointerEnter={() => setEngaged(true)}
        onPointerLeave={() => setEngaged(false)}
        onFocusCapture={() => setEngaged(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setEngaged(false);
        }}
      >
        {cards.map((child, index) => {
          const selected = index === selectedIndex;
          const offset = index - selectedIndex;
          const cardWidth = Math.min(470, Math.max(0, deckWidth - 32));
          const maxOffset = Math.max(
            1,
            selectedIndex,
            cards.length - 1 - selectedIndex,
          );
          const maxAngle = (maxOffset * (engaged ? 3.2 : 2.5) * Math.PI) / 180;
          const rotatedWidth =
            cardWidth * Math.cos(maxAngle) + height * Math.sin(maxAngle);
          const room = Math.max(0, (deckWidth - rotatedWidth) / 2 - 6);
          const spread = Math.min(engaged ? 64 : 24, room / maxOffset);
          const x = selected ? 0 : offset * spread;
          const y = selected ? 0 : Math.min(18, Math.abs(offset) * 5);
          const rotate = selected ? 0 : offset * (engaged ? 5 : 3.5);
          return (
            <div
              key={labels[index] ?? index}
              ref={(node) => {
                cardRefs.current[index] = node;
              }}
              className={`review-deck__card${selected ? " is-active" : ""}`}
              style={{
                zIndex: selected
                  ? cards.length + 1
                  : cards.length - Math.abs(offset),
                transform: `translate3d(calc(-50% + ${x}px), ${y}px, 0) rotate(${rotate}deg) scale(${selected ? 1 : 0.975})`,
              }}
              onPointerEnter={() => setActive(index)}
              onFocusCapture={() => setActive(index)}
              onClick={() => {
                setActive(index);
                setEngaged(true);
              }}
            >
              {child}
            </div>
          );
        })}
      </div>
      {cards.length > 1 && (
        <nav className="review-deck__nav" aria-label="Choose a field to review">
          <button
            type="button"
            className="review-deck__arrow"
            aria-label="Previous field"
            onClick={() => {
              setActive(
                (value) =>
                  (Math.min(value, cards.length - 1) - 1 + cards.length) %
                  cards.length,
              );
              setEngaged(true);
            }}
          >
            ←
          </button>
          <div ref={tabsRef} className="review-deck__tabs">
            <span
              ref={indicatorRef}
              className="review-deck__indicator"
              aria-hidden="true"
            />
            {labels.map((label, index) => (
              <button
                key={`${label}-${index}`}
                ref={(node) => {
                  navItemsRef.current[index] = node;
                }}
                type="button"
                className={`review-deck__dot${index === selectedIndex ? " is-active" : ""}`}
                aria-label={`Show ${label}`}
                aria-current={index === selectedIndex ? "step" : undefined}
                onClick={() => {
                  setActive(index);
                  setEngaged(true);
                }}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span className="review-deck__label">{label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="review-deck__arrow"
            aria-label="Next field"
            onClick={() => {
              setActive(
                (value) =>
                  (Math.min(value, cards.length - 1) + 1) % cards.length,
              );
              setEngaged(true);
            }}
          >
            →
          </button>
        </nav>
      )}
    </div>
  );
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
  const [showEvidence, setShowEvidence] = useState(false);
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
      <div
        className={`field-card${showEvidence ? " field-card--evidence" : ""}`}
      >
        <div className="field-card__topline">
          <span className="field-card__eyebrow">
            {showEvidence ? "Evidence" : "Extracted result"}
          </span>
          <button
            type="button"
            className="field-card__flip"
            aria-pressed={showEvidence}
            aria-label={
              showEvidence ? "Show extracted value" : "Show source evidence"
            }
            onClick={() => setShowEvidence((value) => !value)}
          >
            <span aria-hidden="true">{showEvidence ? "↶" : "↗"}</span>
            {showEvidence ? "Value" : "View source"}
          </button>
        </div>
        {!showEvidence ? (
          <div className="field-card__value">
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
        ) : (
          <figure className="source field-card__source">
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
        )}
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
