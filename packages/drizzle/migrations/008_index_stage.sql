ALTER TABLE document_versions ADD COLUMN indexing_status text NOT NULL DEFAULT 'waiting'
  CHECK(indexing_status IN ('waiting','queued','indexing','ready','failed')),
  ADD COLUMN indexing_error text;
UPDATE document_versions SET indexing_status='ready' WHERE status='extracted';
ALTER TABLE stage_work ADD COLUMN sections jsonb, ADD COLUMN owner_token uuid;
