-- Event mode: a trip can be an 'event' (wedding, party) whose guests join one or more groups; photos can be limited to groups.
-- `cover_key` is the published cover image; `pending_cover_key` the one being uploaded.
ALTER TABLE trips ADD COLUMN type TEXT NOT NULL DEFAULT 'trip' CHECK (type IN ('trip', 'event'));
ALTER TABLE trips ADD COLUMN cover_key TEXT;
ALTER TABLE trips ADD COLUMN pending_cover_key TEXT;

CREATE TABLE event_groups (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (trip_id, name)
);

CREATE TABLE member_groups (
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, group_id)
);
CREATE INDEX idx_member_groups_group ON member_groups (group_id);

CREATE TABLE media_groups (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, group_id)
);
CREATE INDEX idx_media_groups_group ON media_groups (group_id);
