-- Mailbox organisation. None of these touch delivery: an archived or starred email still
-- sends on time. Deleting a scheduled email cancels it in the same UPDATE.
ALTER TABLE emails
  ADD COLUMN starred     boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN deleted_at  timestamptz;

CREATE INDEX emails_user_starred_idx ON emails (user_id) WHERE starred AND deleted_at IS NULL;
CREATE INDEX emails_user_archived_idx ON emails (user_id, archived_at DESC) WHERE archived_at IS NOT NULL AND deleted_at IS NULL;
