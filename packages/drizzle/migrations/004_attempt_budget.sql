ALTER TABLE document_versions
  ADD COLUMN attempt_deadline timestamptz,
  ADD COLUMN cycle_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN eligible_at timestamptz NOT NULL DEFAULT now();
