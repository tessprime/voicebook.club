-- Word timings from a recording's transcript, as a JSON array of
-- {text, startMs, endMs}: served only for a single recording, never in lists.
ALTER TABLE recordings ADD COLUMN transcript_words TEXT;
