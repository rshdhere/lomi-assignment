# Extraction pipeline measurements

## Observed HTTP throttling

A focused local run sent six sequential requests to a fresh Express listener on loopback. Its upload limit was three requests per minute. Each request sent an empty file list to `POST /uploads`. Timings include reading the response body. The first request includes connection setup.

| Request | HTTP status | Duration (ms) | Retry-After (seconds) |
| ------: | ----------: | ------------: | --------------------: |
|       1 |         400 |         101.8 |                       |
|       2 |         400 |           9.5 |                       |
|       3 |         400 |           7.9 |                       |
|       4 |         429 |           7.2 |                    60 |
|       5 |         429 |           5.7 |                    60 |
|       6 |         429 |           5.2 |                    60 |

The run used Node v24.13.0 on an AMD Ryzen 5 5500U with Radeon Graphics. This measures the validation and rate-limit paths. Extraction throughput and database latency require the separate integration workload below.

## Cloud workload

Use a dedicated Codex Cloud machine with Node 24 and Docker Compose, running the exact checkout under test. The integration override sets a deterministic model double with a three-second extraction delay. No external model account is needed. Ports 14000 and 19000 must be available. Start with a fresh project or wait a minute after previous upload tests for its quota to reset.

```sh
docker compose -p lomi-bench -f compose.yaml -f tests/integration/compose.yaml up --build -d
node tests/bench/load.mjs > load-results.json
docker compose -p lomi-bench -f compose.yaml -f tests/integration/compose.yaml stop
```

The harness checks the image bytes against the checkout's backend, worker, packages, lockfile, and fixtures. It verifies that both services use the model double and waits for the three seed documents to finish extracting. The JSON report includes the Git commit, tested source digest, image ID, runtime, and CPU.

| Phase                           | Workload                                                                                                                                                                  | Measurement                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline reads                  | Four clients alternate list and seeded invoice detail reads for eight seconds, with a 150 ms pause between responses and the next read.                                   | Per-operation counts, HTTP status codes and latency in milliseconds.                                                                                                 |
| Extraction and concurrent reads | Eight new invoice uploads, four at a time. Repeat the baseline read mix during the first eight seconds. Poll all accepted documents every 500 ms for up to three minutes. | Upload acceptance latency, read latency under extraction, status polling latency, complete outcomes and elapsed time from upload start to first observed completion. |
| Upload burst                    | Request 32 valid single-file upload manifests, four at a time.                                                                                                            | Counts of 201 and 429 responses and the distribution of advertised retry windows.                                                                                    |

For each operation the report includes sample count, p50, p95, p99, and maximum. An unexpected status, missing quota response, incomplete extraction, or missing invoice evidence makes the run exit nonzero. Each run retains its eight invoices and any granted upload manifests in the isolated project.

Compare read latency during extraction with the baseline for the same checkout. A long upload-to-completion time alongside a fast 202 points to the worker or waiting queue. Polling adds up to roughly one polling interval to observed completion. The model double fixes provider latency and embedding output, so provider capacity needs a separate experiment. This bounded run has no measured 10,000-document throughput result.
