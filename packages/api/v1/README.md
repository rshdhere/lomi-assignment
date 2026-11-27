# Document API

The [OpenAPI contract](../openapi.yaml) covers the multipart endpoints for API clients and the direct upload flow for the browser. A presigned POST requires every returned form field, followed by the PDF file. Complete the batch once all files have uploaded. The server pins each object version and verifies its size, MIME type, PDF structure and checksum before it accepts the batch.

Completion can be retried against the same batch ID. A missing file returns 409. A 422 response with `needsType` identifies the files that need a type selection. Supply their IDs and types in the next completion request. A successful response identifies the document and version of every file, in manifest order. Signing forms expire after one hour. Batch receipts expire after one day.

Each API instance counts upload, review and search requests by source IP. A 429 response includes `Retry-After` in seconds. The Compose API is a single process bound to localhost.
