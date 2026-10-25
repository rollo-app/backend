/**
 * Where can a photo go? Whether `viewer` may feature a photo on their profile. The single place for the rule
 * (featuring, the revealed feed and the cleanups all agree with it). Four levels, the most restrictive wins:
 *  1. private rollo (`trips.featuring_disabled`): nobody, not even the author;
 *  2. the author can always feature their own photos;
 *  3. others need the photo (`media.feature_blocked_at`), the author's membership (`members.allow_featuring`)
 *     and the author's account (`user_settings.allow_featuring`) to allow it.
 * Turning a level off also deletes what it now blocks from other profiles (see `featured.repository`).
 */
export type FeaturingFacts = {
  viewerIsAuthor: boolean;
  /** The rollo is private. */
  rolloPrivate: boolean;
  /** The author blocked this one photo. */
  photoBlocked: boolean;
  /** The author lets others feature their photos of this rollo. */
  memberAllows: boolean;
  /** The author lets others feature any of their photos. */
  accountAllows: boolean;
};

export type FeaturingDenial = "private_rollo" | "author_declined" | null;

/** Why `viewer` can't feature the photo, or null if they can. */
export function featuringDenial(f: FeaturingFacts): FeaturingDenial {
  if (f.rolloPrivate) return "private_rollo";
  if (f.viewerIsAuthor) return null;
  if (f.photoBlocked || !f.memberAllows || !f.accountAllows) return "author_declined";
  return null;
}

export const canFeature = (f: FeaturingFacts): boolean => featuringDenial(f) === null;
