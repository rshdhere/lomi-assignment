CREATE TABLE IF NOT EXISTS upload_batches (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  files jsonb NOT NULL,
  result jsonb
);
CREATE INDEX IF NOT EXISTS upload_batches_created_at ON upload_batches(created_at);
