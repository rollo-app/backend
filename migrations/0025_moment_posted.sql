-- Push preference "Momentos del grupo": someone in your rollo uploaded their daily moment (1 = on, default).
ALTER TABLE user_settings ADD COLUMN notify_moment_posted INTEGER NOT NULL DEFAULT 1;
