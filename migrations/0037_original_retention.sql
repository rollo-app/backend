-- Original retention: every photo now has three files: original (<= 4000 px), display (2048 px compressed JPEG, kept
-- forever) and thumb (800 px). A rollo's originals are deleted 30 days after its reveal unless it keeps them.

-- display_key / display_size_bytes: NULL for uploads from old app builds (they keep their original forever, since the
-- thumb alone would be too small). original_purged_at: when the cron queued the original for deletion.
ALTER TABLE media ADD COLUMN display_key TEXT;
ALTER TABLE media ADD COLUMN display_size_bytes INTEGER;
ALTER TABLE media ADD COLUMN original_purged_at INTEGER;

-- keep_originals: 1 = the originals are never deleted (existing rollos, and later the paid pass; for now set by a superadmin).
-- originals_notice_at: when the "se borran en 5 días" push was claimed. originals_purged_at: when no purgeable original was left.
ALTER TABLE trips ADD COLUMN keep_originals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN originals_notice_at INTEGER;
ALTER TABLE trips ADD COLUMN originals_purged_at INTEGER;

-- Rollos that exist before this migration keep their originals forever.
UPDATE trips SET keep_originals = 1;

-- Push preference "Fotos en máxima calidad por borrarse" (1 = on, default).
ALTER TABLE user_settings ADD COLUMN notify_originals_expiring INTEGER NOT NULL DEFAULT 1;
