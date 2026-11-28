import { useState, useEffect, useRef } from "react";
import { IconCalendarEvent, IconChevronDown } from "@tabler/icons-react";
import type { DocumentSummary, ExtractionStatus } from "@repo/types/reviewer";
import { Card } from "../components/dashboard/card";

const stages = [
  { key: "extracted", label: "Extracted" },
  { key: "extracting", label: "Extracting" },
  { key: "queued", label: "Queued" },
  { key: "failed", label: "Failed" },
] as const;
const stageColors = ["var(--action-blue)", "#91aec9", "#bcc8d3", "#8f9ba7"];
const ringCircumference = 2 * Math.PI * 47;
const dayMs = 86400000;
const dateLabel = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function Analytics({
  docs,
  reviewed,
  pending,
  status,
  selectStatus,
}: {
  docs: DocumentSummary[];
  reviewed: number;
  pending: number;
  status: ExtractionStatus | null;
  selectStatus: (status: ExtractionStatus | null) => void;
}) {
  const [weeks, setWeeks] = useState(1);
  const [chartsEntered, setChartsEntered] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const periodRef = useRef<HTMLDivElement>(null);
  const periodTriggerRef = useRef<HTMLButtonElement>(null);
  const periodOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [today, setToday] = useState(() => Math.floor(Date.now() / dayMs));
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChartsEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!periodOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!periodRef.current?.contains(event.target as Node))
        setPeriodOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    periodOptionRefs.current[weeks === 1 ? 0 : 1]?.focus();
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [periodOpen, weeks]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setToday(Math.floor(Date.now() / dayMs)),
      Math.max(1, (today + 1) * dayMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [today]);
  const buckets = Array.from({ length: 7 }, (_, i) => {
    const end = today - (6 - i) * weeks;
    const start = end - weeks + 1;
    const count = docs.filter((doc) => {
      const day = Math.floor(Date.parse(doc.updatedAt) / dayMs);
      return day >= start && day <= end;
    }).length;
    return {
      end,
      count,
      label:
        dateLabel.format(start * dayMs) +
        (weeks === 1 ? "" : " – " + dateLabel.format(end * dayMs)),
    };
  });
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const n = buckets.reduce((sum, b) => sum + b.count, 0);
  const chartPoints = buckets.map((bucket, index) => ({
    x: 22 + (index * 656) / Math.max(1, buckets.length - 1),
    y: 108 - (bucket.count / max) * 82,
    ...bucket,
  }));
  const linePath = chartPoints
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
  const firstPoint = chartPoints[0];
  const lastPoint = chartPoints.at(-1);
  const areaPath =
    firstPoint && lastPoint
      ? `${linePath} L${lastPoint.x},118 L${firstPoint.x},118 Z`
      : "";
  const stageCounts = stages.map(
    ({ key }) => docs.filter((doc) => doc.status === key).length,
  );
  const totalStages = stageCounts.reduce((sum, count) => sum + count, 0);
  const reviewTotal = reviewed + pending;
  const reviewPercent = reviewTotal
    ? Math.round((reviewed / reviewTotal) * 100)
    : 0;
  return (
    <section className="insights-board" aria-label="Workspace analytics">
      <Card className="activity-card">
        <header className="analytics-heading">
          <div>
            <span className="analytics-kicker">Workspace insights</span>
            <h2>Document activity</h2>
          </div>
          <div className="period-picker" ref={periodRef}>
            <button
              ref={periodTriggerRef}
              type="button"
              className="period-trigger"
              aria-label="Activity period"
              aria-haspopup="menu"
              aria-expanded={periodOpen}
              onClick={() => setPeriodOpen((isOpen) => !isOpen)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setPeriodOpen(true);
                }
              }}
            >
              <IconCalendarEvent size={16} stroke={1.8} aria-hidden="true" />
              <span>Last {weeks === 1 ? "7" : "28"} days</span>
              <IconChevronDown
                size={15}
                stroke={1.8}
                className={
                  periodOpen ? "period-chevron is-open" : "period-chevron"
                }
                aria-hidden="true"
              />
            </button>
            {periodOpen && (
              <div
                className="period-menu"
                role="menu"
                aria-label="Activity date range"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPeriodOpen(false);
                    periodTriggerRef.current?.focus();
                  } else if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp"
                  ) {
                    event.preventDefault();
                    const active = periodOptionRefs.current.findIndex(
                      (option) => option === document.activeElement,
                    );
                    const current = active < 0 ? (weeks === 1 ? 0 : 1) : active;
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    const next = (current + delta + 2) % 2;
                    periodOptionRefs.current[next]?.focus();
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    periodOptionRefs.current[
                      event.key === "Home" ? 0 : 1
                    ]?.focus();
                  }
                }}
              >
                {[
                  { value: 1, label: "Last 7 days", detail: "Daily activity" },
                  { value: 4, label: "Last 28 days", detail: "Four week view" },
                ].map((option, index) => (
                  <button
                    key={option.value}
                    ref={(node) => {
                      periodOptionRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={weeks === option.value}
                    className="period-option"
                    onClick={() => {
                      setWeeks(option.value);
                      setPeriodOpen(false);
                      periodTriggerRef.current?.focus();
                    }}
                  >
                    <span className="period-option-copy">
                      <span>{option.label}</span>
                      <small>{option.detail}</small>
                    </span>
                    {weeks === option.value && (
                      <span className="period-selected" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>
        <div className="activity-total">
          <strong>{n}</strong>
          <span>documents updated</span>
          <span className="activity-period">
            in the last {weeks === 1 ? "7" : "28"} days
          </span>
        </div>
        <div className="activity-chart-wrap">
          <svg
            className="activity-chart"
            viewBox="0 0 700 132"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Document updates by day: ${buckets.map((b) => `${b.label}: ${b.count}`).join(", ")}`}
          >
            <defs>
              <linearGradient id="activity-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#4e98ed" stopOpacity=".24" />
                <stop offset="100%" stopColor="#4e98ed" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="activity-line" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#2864b4" />
                <stop offset="100%" stopColor="#56a4f5" />
              </linearGradient>
            </defs>
            {[26, 56, 86, 118].map((y) => (
              <line
                key={y}
                x1="0"
                x2="700"
                y1={y}
                y2={y}
                className="activity-gridline"
              />
            ))}
            <path d={areaPath} fill="url(#activity-area)" />
            <path d={linePath} className="activity-line" />
            {chartPoints.map((point) => (
              <g key={point.end}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.count ? 4 : 2.5}
                  className="activity-point"
                />
                <text
                  x={point.x}
                  y={point.y - 10}
                  textAnchor="middle"
                  className="activity-value"
                >
                  {point.count}
                </text>
              </g>
            ))}
          </svg>
          <div className="activity-labels" aria-hidden="true">
            {buckets.map((b) => (
              <small key={b.end}>{dateLabel.format(b.end * dayMs)}</small>
            ))}
          </div>
        </div>
      </Card>
      <Card className="pipeline-card pipeline-charts-card">
        <header className="analytics-heading">
          <div>
            <span className="analytics-kicker">At a glance</span>
            <h2>Processing overview</h2>
          </div>
          <span className="pipeline-total">
            <i aria-hidden="true" />
            {docs.length} documents
          </span>
        </header>
        <div className="pipeline-charts">
          <section
            className="pipeline-chart-block status-chart-block"
            aria-label="Documents by extraction status"
          >
            <div className="pipeline-chart-heading">
              <h3>Status mix</h3>
              <span>{totalStages} total</span>
            </div>
            <div className="status-donut-layout">
              <svg
                className="status-donut"
                viewBox="0 0 120 120"
                role="img"
                aria-label={`${totalStages} documents across extraction statuses`}
              >
                <circle
                  className="donut-track"
                  cx="60"
                  cy="60"
                  r="47"
                  transform="rotate(-90 60 60)"
                />
                {stageCounts.map((count, index) => {
                  const length = totalStages
                    ? (count / totalStages) * ringCircumference
                    : 0;
                  const offset = stageCounts
                    .slice(0, index)
                    .reduce(
                      (sum, prior) =>
                        sum +
                        (totalStages
                          ? (prior / totalStages) * ringCircumference
                          : 0),
                      0,
                    );
                  return count > 0 ? (
                    <circle
                      key={stages[index]?.key ?? index}
                      className="donut-segment"
                      cx="60"
                      cy="60"
                      r="47"
                      transform="rotate(-90 60 60)"
                      stroke={stageColors[index]}
                      strokeDasharray={`${Math.max(0, length - 2)} ${ringCircumference - Math.max(0, length - 2)}`}
                      strokeDashoffset={-offset}
                      style={{ opacity: chartsEntered ? 1 : 0 }}
                    />
                  ) : null;
                })}
                <text x="60" y="56" className="donut-total">
                  {totalStages}
                </text>
                <text x="60" y="72" className="donut-caption">
                  documents
                </text>
              </svg>
              <div className="status-legend">
                {stages.map(({ key, label }, index) => (
                  <button
                    key={key}
                    type="button"
                    className="status-legend-item"
                    aria-pressed={status === key}
                    onClick={() => selectStatus(status === key ? null : key)}
                  >
                    <i
                      style={{ backgroundColor: stageColors[index] }}
                      aria-hidden="true"
                    />
                    <span>{label}</span>
                    <strong>{stageCounts[index]}</strong>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section
            className="pipeline-chart-block review-chart-block"
            aria-label="Field review completion"
          >
            <div className="pipeline-chart-heading">
              <h3>Field review</h3>
              <span>
                {reviewed} of {reviewTotal}
              </span>
            </div>
            <svg
              className="review-gauge"
              viewBox="0 0 160 116"
              role="img"
              aria-label={`${reviewPercent}% of fields reviewed`}
            >
              <path
                className="gauge-track"
                d="M 15 96 A 65 65 0 0 1 145 96"
                pathLength="100"
              />
              <path
                className="gauge-value"
                d="M 15 96 A 65 65 0 0 1 145 96"
                pathLength="100"
                strokeDasharray="100 100"
                strokeDashoffset={chartsEntered ? 100 - reviewPercent : 100}
              />
              <text x="80" y="82" className="gauge-percent">
                {reviewPercent}%
              </text>
              <text x="15" y="112" className="gauge-label">
                0
              </text>
              <text x="145" y="112" className="gauge-label">
                100
              </text>
            </svg>
            <p className="review-chart-caption">
              {pending === 0
                ? "All fields reviewed"
                : `${pending} fields still need attention`}
            </p>
          </section>
        </div>
      </Card>
    </section>
  );
}
