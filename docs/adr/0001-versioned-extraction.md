# One extraction path for new uploads and recovery

A reviewer needs an answer about a particular version even after the queue is emptied. The input is a finite PDF with stable identity. Client revisions and reviewer decisions must survive independently of any model or queue lifecycle.

Lambda Architecture maintains batch and low-latency processing paths and combines their outputs. That separation helps when a historical computation and an incremental approximation require different execution models. Here it would mean maintaining evidence validation and review carry-over twice. Kappa Architecture runs replay through the same processing path. It assumes retained inputs and a way to identify or replace the regenerated outputs. [Jay Kreps, Questioning the Lambda Architecture](https://www.oreilly.com/radar/questioning-the-lambda-architecture/)

We use the replay principle at document-version granularity. S3 retains original bytes, Postgres names the exact object version and records outstanding work. A worker reconciles this durable state into BullMQ, claims a version in Postgres and commits the extraction under that claim. On restart the worker can replay queued versions or reclaim an expired lease. A superseded worker cannot commit under an old token. The provider can bill for a repeated call if the first attempt dies before commit.

Reviews attach to extracted fields. The next version compares the same field’s validated quotes and copies an existing review only on exact equality. This survives changes in page offsets and intentionally sends changed punctuation, whitespace or model-selected quote boundaries back to the reviewer. Recent versions appear immediately in the dashboard. Historical values remain readable by version.

## How retrieval fits the assignment

The assignment calls for extracting every expected field from the text of the uploaded version. For example, checking the amount due on an invoice starts with the full parsed text. The parser returns a proposed value and quote. A missing field or a quote that fails the verbatim check becomes a gap with a reason. A reviewer can keep the source value and save a correction beside it. [Assignment](../../assignment.md)

The extension gives the same version a second use. The parser also proposes section start lines. The worker slices the original text and computes chunk embeddings alongside section metadata. It commits the chunks, fields, carry-over decisions and visible outcome together. This keeps an extracted version searchable as soon as it appears in the UI. It also means an embedding-provider failure delays review until the extraction can be retried. [Extraction implementation](../../packages/services/src/extract.ts) · [RAG extension](../../SPEC.md)

When a reviewer asks a question, the model must call the retrieval tool before answering. It chooses Postgres full-text search for exact terms or pgvector cosine search for semantic matches. The API combines retrieved passages with relevant reviewed fields from current extracted versions, optionally scoped to one document. An answer cites retrieved sources by version and exposes their review state. If the search finds no supporting source, the API tells the reviewer it could not establish an answer. [Query implementation](../../packages/services/src/query.ts)

At larger volumes, measure the reconciliation query, queue wait, provider throttling and Postgres write latency separately. A queue backlog with idle model quota calls for additional bounded workers. Provider throttling calls for lower concurrency or coordinated backoff. Neither outcome requires duplicating the extraction path.
