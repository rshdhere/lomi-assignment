CREATE TABLE provider_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  attempt_token uuid REFERENCES extraction_attempts,
  operation text NOT NULL,
  requested_model text NOT NULL,
  returned_model text,
  provider_request_id text,
  input_tokens integer,
  output_tokens integer,
  elapsed_ms integer NOT NULL,
  http_status integer NOT NULL
);
CREATE INDEX provider_usage_attempt ON provider_usage(attempt_token);
