-- The moment's mode at the time it was drawn ('photo' | 'photo_selfie'); NULL on old rows = use the trip's mode.
ALTER TABLE trip_moments ADD COLUMN mode TEXT;
