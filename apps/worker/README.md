# Extraction worker

The worker polls outstanding Postgres versions every 1.5 seconds and offers their IDs to BullMQ. Redis deduplicates waiting jobs by version ID. Up to two extracts run concurrently per worker. A worker renews its Postgres claim every 20 seconds. Another worker can reclaim it after 90 seconds without renewal. Each attempt reads the original pinned S3 version, calls the configured model, builds both retrieval indexes and commits its outcome. A provider or parser error becomes a visible failed state with a manual retry action.

Start with `pnpm --filter @repo/worker start` after migrations. Compose starts this process alongside the backend. For recovery verification, restart the worker during an extraction and observe the same version settle into extracted or failed. Flushing the disposable Compose Redis database exercises work reconstruction from Postgres.
