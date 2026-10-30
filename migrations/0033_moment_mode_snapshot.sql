-- The moment's mode at the time it was drawn ('photo' | 'photo_selfie'); NULL on old rows = use the trip's mode.
ALTER TABLE trip_moments ADD COLUMN mode TEXT;
-- First trip-local day (YYYY-MM-DD) the current moment config applies to; NULL = no restriction. Set when an admin changes it in a running rollo.
ALTER TABLE trips ADD COLUMN moment_from_day TEXT;
