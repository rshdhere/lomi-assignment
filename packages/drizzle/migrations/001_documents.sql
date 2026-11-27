CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  doc_id text PRIMARY KEY,
  title text NOT NULL,
  source_type text NOT NULL DEFAULT 'pdf',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id text NOT NULL REFERENCES documents,
  version integer NOT NULL CHECK (version > 0),
  document_type text CHECK (document_type IN ('invoice','lease','market_report')),
  object_key text NOT NULL,
  object_version text NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','extracting','extracted','failed')),
  error text,
  parsed_text text,
  claim_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version),
  UNIQUE (object_key, object_version)
);
CREATE INDEX extraction_schedule ON document_versions (status, lease_until)
 WHERE status IN ('queued','extracting');

CREATE TABLE extraction_attempts (
  claim_token uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES document_versions,
  started_at timestamptz NOT NULL DEFAULT now(),
  prompt text,
  raw_response text,
  error text
);

CREATE TABLE extracted_values (
  value_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES document_versions,
  field text NOT NULL,
  value text,
  quote text,
  gap_reason text,
  previous_id uuid REFERENCES extracted_values,
  carried_over boolean NOT NULL DEFAULT false,
  UNIQUE (version_id, field),
  CHECK ((value IS NULL AND quote IS NULL AND gap_reason IS NOT NULL)
    OR (value IS NOT NULL AND quote IS NOT NULL AND gap_reason IS NULL))
);

CREATE TABLE reviews (
  value_id uuid PRIMARY KEY REFERENCES extracted_values,
  action text NOT NULL CHECK (action IN ('approve','correct')),
  correction text,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action='approve' AND correction IS NULL) OR (action='correct' AND correction IS NOT NULL))
);

CREATE TABLE chunks (
  chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES document_versions,
  doc_id text NOT NULL REFERENCES documents,
  parent_id uuid REFERENCES chunks,
  doc_type text NOT NULL,
  metadata jsonb NOT NULL,
  text text NOT NULL,
  embedding vector(1536) NOT NULL,
  terms tsvector GENERATED ALWAYS AS (to_tsvector('english',text)) STORED
);
CREATE INDEX chunk_version ON chunks(version_id);
CREATE INDEX chunk_terms ON chunks USING gin (terms);
CREATE INDEX chunk_metadata ON chunks USING gin (metadata);
CREATE INDEX chunk_vectors ON chunks USING hnsw (embedding vector_cosine_ops);
