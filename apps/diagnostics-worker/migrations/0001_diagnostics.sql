CREATE TABLE installations (
  id TEXT PRIMARY KEY, proof_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
  revoked_at INTEGER, quota_day INTEGER NOT NULL DEFAULT -1,
  quota_bytes INTEGER NOT NULL DEFAULT 0, quota_batches INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX installations_revoked ON installations(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE TABLE daily (
  day INTEGER PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0, registrations INTEGER NOT NULL DEFAULT 0
);
-- Short-lived body locators only. Full errors and operation identifiers stay in R2.
CREATE TABLE batches (
  installation_id TEXT NOT NULL, id TEXT NOT NULL, object_key TEXT NOT NULL,
  owner TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','deleting')),
  writers INTEGER NOT NULL DEFAULT 1, cleanup_after INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  metadata TEXT NOT NULL, PRIMARY KEY(installation_id,id)
);
CREATE INDEX batches_expiry ON batches(expires_at) WHERE writers=0;
CREATE INDEX batches_uncertain ON batches(cleanup_after) WHERE writers>0;
-- One compact row per process session; never one ninety-day row per batch/event.
CREATE TABLE sessions (
  installation_id TEXT NOT NULL, session_id TEXT NOT NULL,
  first_received_at INTEGER NOT NULL, last_received_at INTEGER NOT NULL,
  source_from TEXT, source_to TEXT, version TEXT, events INTEGER NOT NULL,
  failures INTEGER NOT NULL, failure_kinds TEXT NOT NULL DEFAULT '[]', source_time_unknown INTEGER NOT NULL DEFAULT 0, batches INTEGER NOT NULL, bytes INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(installation_id,session_id)
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_identity ON sessions(session_id);
