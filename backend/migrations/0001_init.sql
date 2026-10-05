-- Everything here except `state` is reconstructible from ATProto: replay
-- Jetstream from cursor 0 and backfill each member from their PDS.

-- Accounts known to use Voicebook: anyone who has written at least one
-- club.voicebook.recording record.
CREATE TABLE members (
    did TEXT PRIMARY KEY,
    handle TEXT,                         -- mutable display data, never a key
    pds_url TEXT,                        -- from the DID document
    active INTEGER NOT NULL DEFAULT 1,   -- 0 while deactivated or taken down
    discovered_at TEXT NOT NULL,
    backfilled_at TEXT
);

CREATE TABLE recordings (
    uri TEXT PRIMARY KEY,                -- at://did/club.voicebook.recording/rkey
    did TEXT NOT NULL REFERENCES members(did) ON DELETE CASCADE,
    rkey TEXT NOT NULL,
    cid TEXT NOT NULL,
    created_at TEXT NOT NULL,            -- record's createdAt, RFC 3339 UTC
    work TEXT NOT NULL,
    chapter TEXT,
    duration_ms INTEGER,
    notes TEXT,
    blob_cid TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    indexed_at TEXT NOT NULL
);

CREATE INDEX recordings_by_user_date ON recordings(did, created_at);
CREATE INDEX recordings_by_date ON recordings(created_at);

-- app.bsky.graph.follow records written by members. Keyed by rkey because a
-- delete event carries only the record key, not the record.
CREATE TABLE follows (
    actor_did TEXT NOT NULL REFERENCES members(did) ON DELETE CASCADE,
    rkey TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    PRIMARY KEY (actor_did, rkey)
);

CREATE INDEX follows_by_actor_subject ON follows(actor_did, subject_did);
CREATE INDEX follows_by_subject ON follows(subject_did);

-- Process state, e.g. the Jetstream cursor.
CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
