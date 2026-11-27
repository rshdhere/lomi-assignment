# Lomi documentation

## Load and recovery tests, 27 November 2026

The one-hour run completed 104,166 HTTP requests and extracted all 1,118 accepted invoices. Peak intake exceeded extraction capacity and the queue cleared three minutes into cooldown. The separate worker crash and Redis flush test recovered the interrupted revision in 93.160 seconds.

- [Load measurements, screenshots, raw data and reproduction commands](testing/2026-11-27/load.md)
- [Redis recovery procedure, screenshot and recorded events](testing/2026-11-27/recovery.md)
- [Independent AWS cleanup receipt](testing/2026-11-27/aws-cleanup.json)

The disposable runner was an eight-vCPU, 64 GiB EC2 instance in Northern Virginia. Two setup attempts preceded the measured run. The first required read access for the MinIO initialization files. The second required the Docker-compatible worker stop flag. From launch to shutdown request, the instance ran for 1 hour 41 minutes 47 seconds. Estimated instance compute was $0.90 at $0.5292/hour. The test used a deterministic model with a three-second delay.

## Hosted acceptance

[Staging fixture results and production read-only checks](testing/2026-11-28/deployed-smoke.md)

## Application and operations

- [Assignment](../assignment.md) and [extension requirements](../SPEC.md)
- [Local setup and application overview](../README.md)
- [Browser review walkthrough](browser-walkthrough.md)
- [Versioning and recovery design](adr/0001-versioned-extraction.md) and [architecture diagram](architecure.png)
- [API contract](../packages/api/openapi.yaml)
- [AWS infrastructure](../infra/README.md) and [staging and production CI/CD](../infra/github-actions.md)

## Live load-test dashboard

The isolated benchmark can stream OpenTelemetry metrics, logs and traces to Grafana. Open the live dashboard during a run to inspect intake, worker backlog, request latency and a linked API-to-worker trace in Jaeger. [Start the telemetry stack](observability/README.md)

## Archived Grafana dashboard

Import the [load and recovery dashboard JSON](testing/2026-11-27/grafana-dashboard.json) through **Dashboards → New → Import**. Select a **TestData** data source when prompted. If you need to add one, open **Connections → Add new connection → TestData** and select **Save & test**. [Grafana setup guide](https://grafana.com/docs/grafana/latest/datasources/testdata/configure/)

The dashboard opens on the recorded UTC hour. The charts embed 120 samples from the run. The totals and phase latency table use the final benchmark record, and the Redis panel uses the separate crash-recovery events. Zoom into the queue chart to inspect backlog growth and drain.
