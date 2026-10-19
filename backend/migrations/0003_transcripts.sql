-- The text of a recording's transcript (club.voicebook.recording#transcript),
-- if it has one. Recordings indexed before this are filled in by a refresh.
ALTER TABLE recordings ADD COLUMN transcript TEXT;
