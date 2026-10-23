-- Magic link in the login email: a second secret for the same login attempt.
-- SHA-256 of the random token; same expiry, attempts and single use as the code (using either consumes the row).
ALTER TABLE auth_codes ADD COLUMN link_hash TEXT;
-- PKCE-style binding: base64url(SHA-256(verifier)) sent by the phone that asked for the code. The link only works
-- with that verifier, so it can't sign another phone in (login CSRF) or be used by an app that intercepted it.
-- Null (old app builds): no link is generated or emailed.
ALTER TABLE auth_codes ADD COLUMN link_challenge TEXT;
