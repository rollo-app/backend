-- How the per-person photo limit is counted: 'daily' (daily_photo_limit per local day) or 'total' (total_photo_limit
-- for the whole rollo). total_photo_limit is NULL in daily mode. daily_video_limit stays for old rollos and old apps.
ALTER TABLE trips ADD COLUMN photo_limit_mode TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE trips ADD COLUMN total_photo_limit INTEGER;
