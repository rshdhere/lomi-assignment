# Revision and recovery check

Run on a Cloud machine with Docker Compose 2.24.4 or newer and Node 24. From the repository root, start the dedicated integration stack. Its separate project name gives it separate data volumes. It binds the API and upload store to loopback ports 14000 and 19000. The model double is internal to that project.

```sh
docker compose -p lomi-check -f compose.yaml -f tests/integration/compose.yaml up -d --build
curl --retry 60 --retry-connrefused --retry-delay 2 --fail http://localhost:14000/health
node tests/integration/revision.mjs --recovery
```

The test creates an invoice, rejects an in-flight revision, interrupts the worker and empties the integration project's Redis. Allow time for the 90-second database lease to expire. It checks the recovered evidence, applies reviews, uploads the revised invoice and checks both changed fields, the carried correction and v1 history. It asks both lexical and semantic questions and checks that each cites the reviewed vendor correction. It then verifies rejection of fabricated evidence and exercises missing-file retry and duplicate completion of a presigned batch. Omit `--recovery` for a faster test without interruption. Each run creates new documents in the integration project.

The double deliberately produces a hallucinated report field. It supplies deterministic invoice values and embeddings for repeatable lifecycle assertions. The default Compose project always calls the configured model. The browser test in `apps/frontend` runs against that live configuration.
