# Live load-test dashboard

The disposable `lomi-bench` stack sends API and worker telemetry over OTLP/HTTP to the OpenTelemetry Collector. Prometheus scrapes the Collector every five seconds, Loki stores application events and Jaeger stores traces. Grafana provisions all three data sources and the live dashboard at startup. The historical November 27 measurements have a separate [recorded dashboard](../../docs/testing/2026-11-27/grafana-dashboard.json).

## Run on a disposable cloud host

Use the exact checkout under test with Docker Compose and Node 24. The integration override selects the deterministic model. Run these commands from the repository root on the benchmark machine.

```sh
bench() {
  docker compose -p lomi-bench -f compose.yaml -f tests/integration/compose.yaml -f infra/observability/compose.yaml "$@"
}

bench up -d --build
curl --retry 60 --retry-all-errors --retry-delay 2 --fail --silent --show-error http://127.0.0.1:13000/api/health
node tests/bench/load.mjs > load-results.json
node tests/bench/verify-observability.mjs > telemetry.json
sleep 61
node tests/bench/soak.mjs > soak.jsonl
```

While the benchmark runs, forward the two UI ports over SSH in a second terminal on your workstation, using the SSH identity and hostname of your test machine.

```sh
ssh -N -L 13000:127.0.0.1:13000 -L 16686:127.0.0.1:16686 user@benchmark-host
```

Open the [live dashboard](http://127.0.0.1:13000/d/lomi-load-live) in your browser. Grafana serves the dashboard and its provisioned data sources to a read-only viewer. The second loopback port serves the [native Jaeger trace viewer](http://127.0.0.1:16686/). Application containers reach the Collector on the project's Docker network. The application also runs independently with the original Compose configuration.

The telemetry check queries the provisioned Jaeger panel through Grafana, finds an extraction span whose parent is the upload request, and uses that trace ID to find both services’ logs in Loki. It also checks the request, extraction and queue metrics from Prometheus.

The hosted baseline captured all twelve panels and a six-span upload trace in Chromium. The evidence includes both screenshots and their underlying queries and timings. [Grafana and Jaeger captures](../../docs/testing/2026-11-28/ci-acceptance.md#live-telemetry)

## Run in GitHub Actions

Once the workflow is on the default branch, open **Actions → Load-test observability → Run workflow** and select the ref to test. The default runs the eight-invoice baseline. Select **Run the full one-hour soak** to collect sustained load evidence as well. Download the run artifact for the Grafana and Jaeger screenshots, correlated spans, baseline and optional soak events. For interactive viewing during a run, use the SSH-forwarded dashboard on your disposable host. [Workflow definition](../../.github/workflows/benchmark.yml)

## Read the panels

- **Intake and backlog.** Compare the number of queued versions with the age of the oldest queued version. Postgres supplies the gauges. An increasing age during steady intake means reviewers are waiting longer for a free extraction slot. Expired claims are eligible for reconciliation.
- **Reads and extraction.** API p95 is grouped by route and method. Worker p50 and p95 cover successful extraction processing. Compare these with the client-observed upload-to-extracted time in `soak.jsonl` to see how queueing and polling affect reviewer wait time. Rates and percentiles need consecutive scrapes. Quiet phases can show an empty series.
- **Logs and traces.** Expand an entry under **API and worker events**, then select **Open trace in Jaeger** to view its span timeline in the native UI. **Recent extraction traces** searches the worker service directly. For an instrumented upload, open the trace to inspect the request and the extraction across the queue boundary. The log pipeline carries the application’s structured telemetry events.
- **Evidence.** Choose an absolute UTC time range covering the run before capturing the dashboard. Save the screenshot and the client result files alongside the tested commit, worker concurrency and host configuration. At high request rates Jaeger evicts the oldest traces, so capture interesting traces during the peak.

## Storage and shutdown

Prometheus keeps metrics in the project’s `bench-metrics` volume using its default retention. Loki retains logs for 24 hours in `bench-logs`. Jaeger holds the newest 10,000 traces in memory and loses them when the container stops. Stop the dedicated stack after saving the evidence.

```sh
bench down
```

Named volumes survive this command and can be read again on the same machine by starting the same Compose project. Terminating the disposable host removes data stored on its ephemeral disk. The observability overlay supplies all instrumentation settings for this lab. The AWS application environments continue using their own runtime configuration.

## Configuration references

- The Collector protocol receivers and exporters use the pinned [OpenTelemetry Collector Contrib release](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.166.0). Prometheus queries use the Collector’s [metric name translation](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.166.0/exporter/prometheusexporter/README.md).
- Loki uses native [OTLP ingestion](https://grafana.com/docs/loki/latest/send-data/otel/) with a v13 schema. Grafana uses a [Loki derived field](https://grafana.com/docs/grafana/latest/datasources/loki/configure-loki-data-source/#derived-fields) to open the native Jaeger UI for the selected trace ID.
- Jaeger uses the release’s [all-in-one memory backend](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/internal/all-in-one.yaml) with a smaller trace limit for the test host. Version 2.20 supplies the HTTP search route that Grafana’s Jaeger table queries. Check a populated search panel before updating either image. [Jaeger query routes](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/internal/extension/jaegerquery/internal/http_handler.go)
