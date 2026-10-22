-- Lookups and deletes of featured rows by photo (feature block, feed's featuredByMe, cascades from media).
CREATE INDEX idx_featured_media ON featured (media_id);
