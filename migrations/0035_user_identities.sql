-- Accounts from an external sign-in provider (Google; Apple later) linked to a user. `subject` is the provider's stable
-- user id (the token's `sub`): it finds the user even if the provider account's email changes. The first sign-in links
-- by email (verified by the provider), so an existing email account keeps its data.
CREATE TABLE user_identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX idx_user_identities_user ON user_identities (user_id);
