-- A claim token can be redeemed only once.
ALTER TABLE friend_claims ADD COLUMN used_at INTEGER;
