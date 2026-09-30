-- Email + password sign in from the login screen. NULL for accounts that only use Google.
ALTER TABLE users ADD COLUMN password_hash text;
