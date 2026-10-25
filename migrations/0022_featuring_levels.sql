-- Where can your photos go? Four levels, the most restrictive wins:
-- user_settings.allow_featuring: others may feature any of your photos (1 = yes, default).
-- members.allow_featuring: others may feature your photos of this rollo (1 = yes, default).
-- trips.featuring_disabled: private rollo, nobody may feature its photos, not even their author (0 = no, default).
-- The per-photo level is media.feature_blocked_at (0009).

ALTER TABLE user_settings ADD COLUMN allow_featuring INTEGER NOT NULL DEFAULT 1;
ALTER TABLE members ADD COLUMN allow_featuring INTEGER NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN featuring_disabled INTEGER NOT NULL DEFAULT 0;
