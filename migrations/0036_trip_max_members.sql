-- Maximum number of active participants (members with left_at IS NULL AND removed_at IS NULL) per rollo.
-- Free rollos get 15; paid rollos/events will raise it later. Enforced atomically in the member INSERT/UPDATE statements.
ALTER TABLE trips ADD COLUMN max_members INTEGER NOT NULL DEFAULT 15;

-- Rollos that already have more than 15 active members keep working: their cap is their current active count
-- (nobody is kicked out, but nobody new fits until a spot opens or the cap is raised).
UPDATE trips SET max_members = (
  SELECT COUNT(*) FROM members m WHERE m.trip_id = trips.id AND m.left_at IS NULL AND m.removed_at IS NULL
)
WHERE (SELECT COUNT(*) FROM members m WHERE m.trip_id = trips.id AND m.left_at IS NULL AND m.removed_at IS NULL) > 15;
