-- Files attached to a campaign; every email in the campaign carries them.
-- Uploaded before the campaign exists, so campaign_id is NULL until "schedule" links them.
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id   uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_campaign_idx ON attachments (campaign_id);
CREATE INDEX attachments_orphans_idx ON attachments (user_id, created_at) WHERE campaign_id IS NULL;
