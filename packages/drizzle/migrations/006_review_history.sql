ALTER TABLE reviews ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE TABLE review_history (
  value_id uuid NOT NULL REFERENCES extracted_values ON DELETE CASCADE,
  revision integer NOT NULL,
  action text NOT NULL,
  correction text,
  note text,
  recorded_at timestamptz NOT NULL,
  origin text NOT NULL,
  PRIMARY KEY(value_id,revision)
);
INSERT INTO review_history
SELECT value_id,revision,action,correction,note,updated_at,'legacy' FROM reviews;
CREATE FUNCTION record_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN NEW.revision=OLD.revision+1; END IF;
  INSERT INTO review_history VALUES(NEW.value_id,NEW.revision,NEW.action,NEW.correction,
    NEW.note,NEW.updated_at,CASE WHEN TG_OP='INSERT' AND EXISTS
    (SELECT 1 FROM extracted_values WHERE value_id=NEW.value_id AND carried_over)
    THEN 'carry' ELSE 'review' END);
  RETURN NEW;
END
$$;
CREATE TRIGGER increment_review_revision BEFORE UPDATE ON reviews FOR EACH ROW
EXECUTE FUNCTION record_review_decision();
CREATE TRIGGER initial_review_history AFTER INSERT ON reviews FOR EACH ROW
EXECUTE FUNCTION record_review_decision();
