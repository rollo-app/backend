-- Exempts a user from the limits on creating rollos. Set by hand with SQL (no endpoint sets it). 0 = limited.
ALTER TABLE users ADD COLUMN unlimited_rollos INTEGER NOT NULL DEFAULT 0;
