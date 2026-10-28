-- The author archived the photo after the reveal: only they still see it (gallery, download, likes, comments).
-- Everyone else stops seeing it everywhere (feed, profiles, "Tu actividad", comments, downloads). NULL = not archived.
ALTER TABLE media ADD COLUMN archived_at INTEGER;
