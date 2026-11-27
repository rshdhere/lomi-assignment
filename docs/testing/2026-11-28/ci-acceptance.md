# Hosted reviewer workflow and recovery

On 28 November 2026 in India (27 November UTC), GitHub Actions tested commit `3e8615ec7e36ff1e62a62357a6e1ba8b19e3c9cd` on a disposable Ubuntu runner. Chromium used the dashboard, signed storage uploads, API and worker backed by PostgreSQL, Redis, MinIO and the deterministic model. The browser scenario passed in 15.2 seconds. The application job passed lint, type checking, the workspace tests against PostgreSQL and the build. Terraform checks also passed. The separate telemetry job failed on this SHA and staging deployment was skipped. [Actions run](https://github.com/rshdhere/lomi-assignment/actions/runs/46068341394)

The recovery test killed the worker during v2 extraction, observed seven Redis keys, flushed them to zero and restarted the running stack. V2 finished 94.297 seconds after interruption. All four approvals and one correction on v1 survived. V2 had five distinct fields, three carried reviews and two pending fields. A separate controlled provider fault reached a visible failed state, then a retry produced five fields. The suite also checked the in-flight revision conflict, exact evidence, versioned citations and partial batch replay. [Recovery events](ci-recovery.jsonl) · [Browser and recovery job](https://github.com/rshdhere/lomi-assignment/actions/runs/46068341394/job/140738999697)

## What the reviewer saw

Chromium opened the seeded market report and verified that the missing median household income appeared as a gap.

![Seeded market report with a visible evidence gap](ci-report-gap.png)

Chromium uploaded a fresh invoice, corrected its vendor, approved the remaining fields, and recorded the completed v1 review.

![Invoice v1 with all five fields reviewed](ci-invoice-reviewed.png)

After uploading the revised PDF, Chromium verified that the due date and total returned to pending and that three reviews carried over. Switching the version selector back to v1 showed the original correction and read-only history.

![Invoice v2 with changed fields pending and unchanged reviews carried over](ci-invoice-revised.png)

## Live telemetry

GitHub Actions ran an eight-invoice baseline on commit `b0c2ce95eadad5ea8154138054a4308a0c627e51` with two worker slots and a deterministic three-second model. All eight extracted. Upload-to-extracted p95 was 13.1 seconds. The application, Terraform, browser, recovery and telemetry checks passed. The first one-hour soak has its own archived measurements. [Hosted run](https://github.com/rshdhere/lomi-assignment/actions/runs/46070348250) · [Baseline JSON](live-baseline.json) · [First soak](../2026-11-27/load.md)

Chromium opened Grafana as a read-only viewer. It displayed the queue rising to eight and draining, latency by route, Loki events and the recent-traces table. The capture used the measured baseline interval. [Browser query and render results](live-dashboard-render.json)

![Live Grafana dashboard during the hosted baseline](live-grafana.png)

Trace `90f5ca885f8ef323c24b401a47dde1b4` shows the API accepting the upload in 21.6 ms, followed by a wait of about 6.5 seconds before a worker claimed the invoice. The worker took about three seconds to read the pinned PDF, parse it, call the model and commit the result. The verifier found both services’ Loki events under the same trace ID and opened the trace in Jaeger. [Span timings and log correlation](live-telemetry.json)

![Jaeger timeline showing the accepted upload, queue wait and four steps inside the worker](live-jaeger.png)
