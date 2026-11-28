ALTER TABLE extracted_values
  ADD COLUMN model_value text,
  ADD COLUMN quote_start integer,
  ADD COLUMN quote_end integer,
  ADD CONSTRAINT evidence_span CHECK (
    (quote_start IS NULL AND quote_end IS NULL) OR
    (quote IS NOT NULL AND quote_start IS NOT NULL AND quote_end IS NOT NULL
      AND quote_start >= 0 AND quote_end > quote_start)
  );
