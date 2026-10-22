-- Soft delete: the admin can delete a photo, but the row stays so it keeps
-- counting toward the day's quota (deleting is not "retrying") and the id can't be reused.
ALTER TABLE media ADD COLUMN deleted_at INTEGER;
