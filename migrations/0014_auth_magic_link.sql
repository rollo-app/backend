-- Magic link in the login email: a second secret for the same login attempt.
-- SHA-256 of the random token; same expiry, attempts and single use as the code (using either consumes the row).
ALTER TABLE auth_codes ADD COLUMN link_hash TEXT;
