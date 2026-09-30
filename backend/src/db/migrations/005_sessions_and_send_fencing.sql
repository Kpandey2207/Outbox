-- Server-side sessions, so logging out (or an account takeover fix) really ends a session.
-- Only a SHA-256 of the cookie value is stored; a database leak does not leak live cookies.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Send fencing (see emailRepository):
--   claim_token        set by each claim; later writes by that attempt must present it, so a
--                      worker that stalled past its lease cannot act on a row someone else owns.
--   smtp_started_at    set right before the SMTP conversation starts. A row interrupted while
--                      it is NULL provably never reached SMTP and is safe to send again.
ALTER TABLE emails
  ADD COLUMN claim_token     uuid,
  ADD COLUMN smtp_started_at timestamptz;

-- Idempotency keys are client supplied; keep them bounded.
ALTER TABLE campaigns ADD CONSTRAINT campaigns_idempotency_key_len CHECK (char_length(idempotency_key) <= 200);
