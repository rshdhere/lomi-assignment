# One extraction path for new uploads and recovery

A reviewer needs an answer about a particular version even after the queue is emptied. The input is a finite PDF with stable identity. Client revisions and reviewer decisions must survive independently of any model or queue lifecycle.

Lambda Architecture maintains batch and low-latency processing paths and combines their outputs. That separation helps when a historical computation and an incremental approximation require different execution models. Here it would mean maintaining evidence validation and review carry-over twice. Kappa Architecture runs replay through the same processing path. It assumes retained inputs and a way to identify or replace the regenerated outputs. [Jay Kreps, Questioning the Lambda Architecture](https://www.oreilly.com/radar/questioning-the-lambda-architecture/)

We use the replay principle at document-version granularity. S3 retains original bytes, Postgres names the exact object version and records outstanding work. A worker reconciles this durable state into BullMQ, claims a version in Postgres and commits the extraction under that claim. On restart the worker can replay queued versions or reclaim an expired lease. A superseded worker cannot commit under an old token. The provider can bill for a repeated call if the first attempt dies before commit.

Reviews attach to extracted fields. The next version compares the same field’s validated quotes and copies an existing review only on exact equality. This survives changes in page offsets and intentionally sends changed punctuation, whitespace or model-selected quote boundaries back to the reviewer. Recent versions appear immediately in the dashboard. Historical values remain readable by version.

At larger volumes, measure the reconciliation query, queue wait, provider throttling and Postgres write latency separately. A queue backlog with idle model quota calls for additional bounded workers. Provider throttling calls for lower concurrency or coordinated backoff. Neither outcome requires duplicating the extraction path.
