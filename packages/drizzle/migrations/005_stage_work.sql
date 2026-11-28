CREATE TABLE stage_work (
  version_id uuid NOT NULL REFERENCES document_versions ON DELETE CASCADE,
  stage text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  next_offer_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(version_id, stage, generation)
);
CREATE INDEX stage_work_schedule ON stage_work(stage, next_offer_at, version_id);

CREATE FUNCTION sync_extraction_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('extracted', 'failed') THEN
    DELETE FROM stage_work WHERE version_id=NEW.version_id AND stage='extract';
  ELSIF NEW.status='queued' THEN
    INSERT INTO stage_work(version_id,stage,next_offer_at)
    VALUES(NEW.version_id,'extract',NEW.eligible_at)
    ON CONFLICT (version_id,stage,generation) DO UPDATE SET next_offer_at=EXCLUDED.next_offer_at;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_extraction_work AFTER INSERT OR UPDATE OF status ON document_versions
FOR EACH ROW EXECUTE FUNCTION sync_extraction_work();
INSERT INTO stage_work(version_id,stage,next_offer_at)
SELECT version_id,'extract',eligible_at FROM document_versions WHERE status IN ('queued','extracting');
