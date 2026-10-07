-- Sessions created from a verified service-auth token (see src/auth.rs).
-- Unlike the rest of the index, sessions aren't reconstructible: losing them
-- just means the frontend signs users in to this service again.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,         -- SHA-256 of the cookie's token, hex
    did TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX sessions_by_did ON sessions(did);
