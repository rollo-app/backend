-- Global role for the backoffice panel. Not the per-rollo role (members.role).
ALTER TABLE users ADD COLUMN app_role TEXT NOT NULL DEFAULT 'user' CHECK (app_role IN ('user', 'superadmin'));
