-- A recording's activity (reading, passage, freeSpeech, pitch, resonance;
-- NULL for records from before activities, which were all reading) and, for
-- a passage, which one (passage.id in the record).
ALTER TABLE recordings ADD COLUMN activity TEXT;
ALTER TABLE recordings ADD COLUMN passage_id TEXT;

CREATE INDEX recordings_by_user_passage ON recordings(did, passage_id, created_at);
