-- Only your own photos or a friend's can be featured on a profile. Drop the existing featured rows whose author is
-- neither the profile owner nor a friend of the owner (they can't be featured again until the two are friends).
DELETE FROM featured WHERE NOT EXISTS (
  SELECT 1 FROM media m JOIN members author ON author.id = m.member_id
  WHERE m.id = featured.media_id
    AND (author.user_id = featured.user_id
         OR EXISTS (SELECT 1 FROM friendships fr
                    WHERE fr.user_a = MIN(author.user_id, featured.user_id) AND fr.user_b = MAX(author.user_id, featured.user_id)))
);
