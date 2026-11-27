# Configuration

The API advertises its active upload limits at `GET /limits`. The Compose defaults allow ten files of up to 10 MiB each. Set `MAX_BATCH_FILES` and `MAX_FILE_BYTES` to override them. Limits must be positive integers. Endpoint, model, and storage settings live in [the root Compose file](../../compose.yaml).
