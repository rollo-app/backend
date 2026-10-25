-- Daily moment (BeReal style): one random notification time per member per day inside the rollo's window.
-- trips.moment_mode: 'off' (default: old rollos and old apps), 'photo' or 'photo_selfie'.
-- trips.moment_window_start/end: minutes since local midnight (trip timezone), 540 = 09:00, 1380 = 23:00.
-- trip_moments: the drawn time (notify_at, epoch ms) and, once taken, the photo (and selfie) of that day.
-- media.moment_day: local day of the moment this media belongs to; media.paired_media_id: the selfie/main pair.
-- user_settings.notify_daily_moment: push preference (1 = on, default).

ALTER TABLE trips ADD COLUMN moment_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE trips ADD COLUMN moment_window_start INTEGER NOT NULL DEFAULT 540;
ALTER TABLE trips ADD COLUMN moment_window_end INTEGER NOT NULL DEFAULT 1380;
ALTER TABLE user_settings ADD COLUMN notify_daily_moment INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media ADD COLUMN moment_day TEXT;
ALTER TABLE media ADD COLUMN paired_media_id TEXT;

CREATE TABLE trip_moments (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  notify_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  media_id TEXT,
  selfie_media_id TEXT,
  taken_at INTEGER,
  in_window INTEGER,
  PRIMARY KEY (trip_id, user_id, day)
);
