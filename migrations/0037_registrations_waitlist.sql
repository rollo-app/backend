-- Waitlist for when new registrations are closed (the switch itself lives in app_settings, key 'registrations_closed').
-- Double opt-in: a person is on the list for real only once they open the confirm link. Only hashes (SHA-256) of the two
-- link tokens are stored, like auth codes. `last_sent_at` limits the confirmation email to once per 24 h per address.
CREATE TABLE waitlist (
  email                  TEXT PRIMARY KEY,
  source                 TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'web')),
  created_at             INTEGER NOT NULL,
  confirm_token_hash     TEXT NOT NULL,
  confirmed_at           INTEGER,
  unsubscribe_token_hash TEXT NOT NULL,
  unsubscribed_at        INTEGER,
  last_sent_at           INTEGER
);

CREATE UNIQUE INDEX idx_waitlist_confirm_token ON waitlist (confirm_token_hash);
CREATE UNIQUE INDEX idx_waitlist_unsubscribe_token ON waitlist (unsubscribe_token_hash);
CREATE INDEX idx_waitlist_created ON waitlist (created_at);
