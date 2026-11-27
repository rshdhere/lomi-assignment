import {
  context,
  metrics,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  isSpanContextValid,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export async function startTelemetry(serviceName: "lomi-api" | "lomi-worker") {
  if (
    !process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_SDK_DISABLED === "true"
  )
    return;
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const sdk = new NodeSDK({ serviceName, autoDetectResources: false });
  sdk.start();
  return sdk;
}

// Store only the trace and parent span IDs and sampling flag. Original request
// headers, baggage, and trace state never enter the durable work record.
export function currentTraceparent(): string | undefined {
  const parent = trace.getActiveSpan()?.spanContext();
  if (!parent || !isSpanContextValid(parent)) return;
  return `00-${parent.traceId}-${parent.spanId}-${(parent.traceFlags & 1).toString(16).padStart(2, "0")}`;
}

function parentContext(value?: string): Context {
  const fields = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/.exec(value ?? "");
  if (!fields) return ROOT_CONTEXT;
  const parent = {
    traceId: fields[1]!,
    spanId: fields[2]!,
    traceFlags: Number(fields[3]),
    isRemote: true,
  };
  return isSpanContextValid(parent)
    ? trace.setSpanContext(ROOT_CONTEXT, parent)
    : ROOT_CONTEXT;
}

function completed(
  span: Span,
  event: string,
  attributes: Attributes,
  failed: boolean,
) {
  span.setAttributes(attributes);
  if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
  logs.getLogger("lomi").emit({
    body: event,
    severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
    attributes,
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
}

export function httpTelemetry() {
  const meter = metrics.getMeter("lomi");
  const calls = meter.createCounter("lomi.http.requests");
  const duration = meter.createHistogram("lomi.http.request.duration", {
    unit: "s",
    advice: {
      explicitBucketBoundaries: [
        0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
      ],
    },
  });
  return (rawMethod: string) => {
    const method = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ].includes(rawMethod)
      ? rawMethod
      : "OTHER";
    const start = performance.now();
    const span = trace
      .getTracer("lomi")
      .startSpan(method, { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    return {
      run: (next: () => void) =>
        context.with(trace.setSpan(ROOT_CONTEXT, span), next),
      finish(route: string, status: number, aborted: boolean) {
        const attrs = {
          route,
          method,
          status_class: aborted ? "aborted" : Math.floor(status / 100) + "xx",
        };
        calls.add(1, attrs);
        duration.record((performance.now() - start) / 1000, attrs);
        span.updateName(`${method} ${route}`);
        completed(
          span,
          "HTTP request completed",
          attrs,
          aborted || status >= 500,
        );
      },
    };
  };
}

type Outcome = "extracted" | "failed" | "skipped";
export function extractionTelemetry() {
  const meter = metrics.getMeter("lomi");
  const attempts = meter.createCounter("lomi.extraction.attempts");
  const duration = meter.createHistogram("lomi.extraction.duration", {
    unit: "s",
    advice: {
      explicitBucketBoundaries: [
        0.1, 0.5, 1, 2, 3, 5, 10, 20, 30, 60, 120, 300,
      ],
    },
  });
  return async (parent: string | undefined, work: () => Promise<Outcome>) => {
    const start = performance.now();
    const span = trace
      .getTracer("lomi")
      .startSpan(
        "extract version",
        { kind: SpanKind.CONSUMER },
        parentContext(parent),
      );
    let outcome: Outcome = "failed";
    try {
      outcome = await context.with(trace.setSpan(ROOT_CONTEXT, span), work);
    } finally {
      attempts.add(1, { outcome });
      duration.record((performance.now() - start) / 1000, { outcome });
      completed(
        span,
        "Extraction attempt completed",
        { outcome },
        outcome === "failed",
      );
    }
  };
}

export type ExtractionStage =
  "read pinned PDF" | "parse PDF" | "extract and enrich" | "commit extraction";

export function extractionStage<T>(
  stage: ExtractionStage,
  work: () => Promise<T>,
): Promise<T> {
  if (!trace.getActiveSpan()?.isRecording()) return work();
  return trace.getTracer("lomi").startActiveSpan(stage, async (span) => {
    try {
      return await work();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function observeQueue(
  snapshot: () => Promise<{
    queued: number;
    extracting: number;
    expiredClaims: number;
    oldestQueuedSeconds: number;
  }>,
) {
  const meter = metrics.getMeter("lomi");
  const queued = meter.createObservableGauge("lomi.queue.queued");
  const extracting = meter.createObservableGauge("lomi.queue.extracting");
  const expired = meter.createObservableGauge("lomi.queue.expired_claims");
  const oldest = meter.createObservableGauge("lomi.queue.oldest_queued", {
    unit: "s",
  });
  meter.addBatchObservableCallback(
    async (result) => {
      const counts = await snapshot().catch(() => undefined);
      if (!counts) return;
      result.observe(queued, counts.queued);
      result.observe(extracting, counts.extracting);
      result.observe(expired, counts.expiredClaims);
      result.observe(oldest, counts.oldestQueuedSeconds);
    },
    [queued, extracting, expired, oldest],
  );
}
