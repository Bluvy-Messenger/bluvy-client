/**
 * Who can see the "Bluvy DM" badge on the user's Bluesky profile. Must match
 * the showButtonTo values bsky-app's BluvyButton reads
 * (bsky-app/src/state/queries/bluvy.ts) -- 'mutual' means mutual followers
 * with the profile owner, same population as this app's "contacts".
 */
export type BadgeVisibility = 'everyone' | 'mutual' | 'nothing';

export const DEFAULT_BADGE_VISIBILITY: BadgeVisibility = 'everyone';

export const BADGE_VISIBILITY_OPTIONS: readonly BadgeVisibility[] = [
  'everyone',
  'mutual',
  'nothing',
];
