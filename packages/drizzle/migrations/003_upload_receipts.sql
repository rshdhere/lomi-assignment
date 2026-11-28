CREATE TABLE upload_receipts (
  scope text NOT NULL,
  request_key uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  PRIMARY KEY (scope, request_key)
);
CREATE INDEX upload_receipt_expiry ON upload_receipts(expires_at);
