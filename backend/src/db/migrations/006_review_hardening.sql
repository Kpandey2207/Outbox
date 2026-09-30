-- Slack's incoming webhook is bound to the channel the user picked during install, so it
-- works even when the bot was never invited to that channel (chat.postMessage would fail
-- with not_in_channel). Stored encrypted like the bot token.
ALTER TABLE slack_installations ADD COLUMN webhook_url text;

-- SHA-256 of what a campaign request asked for. Reusing an Idempotency-Key with a different
-- request is refused instead of silently returning the first campaign.
ALTER TABLE campaigns ADD COLUMN request_hash bytea;
