-- Photo contest for events: a description on the cover, the organizer's finalists and one vote per guest.
-- All columns are NULL/0 for existing rows. `contest_winner_media_id` has no FK on purpose: deleting the winning photo must not fail.
ALTER TABLE trips ADD COLUMN description TEXT;
ALTER TABLE trips ADD COLUMN contest_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN contest_voting_hours INTEGER NOT NULL DEFAULT 72;
ALTER TABLE trips ADD COLUMN contest_select_notified_at INTEGER;
ALTER TABLE trips ADD COLUMN contest_reminder_notified_at INTEGER;
ALTER TABLE trips ADD COLUMN contest_cancelled_at INTEGER;
ALTER TABLE trips ADD COLUMN contest_tie_notified_at INTEGER;
ALTER TABLE trips ADD COLUMN contest_closed_at INTEGER;
ALTER TABLE trips ADD COLUMN contest_winner_media_id TEXT;

CREATE TABLE contest_finalists (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, media_id)
);

CREATE TABLE contest_votes (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX idx_contest_votes_media ON contest_votes (trip_id, media_id);
