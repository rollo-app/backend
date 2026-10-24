-- Exact thumbnail size the upload URL is signed for. NULL on rows registered before this migration.
ALTER TABLE media ADD COLUMN thumb_size_bytes INTEGER;
