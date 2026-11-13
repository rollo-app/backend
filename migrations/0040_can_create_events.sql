-- Creating events (POST /trips with type "event") is enabled per account from the backoffice, for now.
ALTER TABLE users ADD COLUMN can_create_events INTEGER NOT NULL DEFAULT 0;
