-- Profile badge, assigned by hand with SQL (no endpoint sets it). NULL = none.
ALTER TABLE users ADD COLUMN badge TEXT CHECK (badge IN ('founder', 'first_edition'));
