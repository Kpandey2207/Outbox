CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id   text UNIQUE,
  email       text NOT NULL UNIQUE,
  name        text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A mailbox a user sends from. Rate limits and throttling are enforced per sender.
CREATE TABLE senders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text,
  smtp_user     text NOT NULL,
  smtp_pass     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

CREATE TABLE slack_installations (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  team_id       text NOT NULL,
  team_name     text,
  bot_token     text NOT NULL,
  channel_id    text NOT NULL,
  channel_name  text,
  installed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id         uuid NOT NULL REFERENCES senders(id),
  subject           text NOT NULL,
  body              text NOT NULL,
  start_at          timestamptz NOT NULL,
  delay_between_ms  integer NOT NULL CHECK (delay_between_ms >= 0),
  hourly_limit      integer NOT NULL CHECK (hourly_limit > 0),
  total_recipients  integer NOT NULL CHECK (total_recipients > 0),
  -- Client supplied key so a retried "schedule" request never creates a second campaign.
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TYPE email_status AS ENUM ('scheduled', 'sending', 'sent', 'failed', 'cancelled');

CREATE TABLE emails (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id           uuid NOT NULL REFERENCES senders(id),
  recipient           text NOT NULL,
  subject             text NOT NULL,
  body                text NOT NULL,
  scheduled_at        timestamptz NOT NULL,
  status              email_status NOT NULL DEFAULT 'scheduled',
  attempts            integer NOT NULL DEFAULT 0,
  reschedule_count    integer NOT NULL DEFAULT 0,
  last_error          text,
  sending_started_at  timestamptz,
  sent_at             timestamptz,
  message_id          text,
  preview_url         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- One email per recipient per campaign, even if the CSV repeats an address.
  UNIQUE (campaign_id, recipient),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX emails_user_status_scheduled_idx ON emails (user_id, status, scheduled_at);
CREATE INDEX emails_user_status_sent_idx ON emails (user_id, status, sent_at DESC);
CREATE INDEX emails_status_scheduled_idx ON emails (status, scheduled_at);
