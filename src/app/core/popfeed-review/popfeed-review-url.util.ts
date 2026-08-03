// Popfeed's own branded routing (not a shared multi-client convention like
// bsky post URLs), so unlike bsky-post-url.util.ts this one IS host-scoped.

export interface PopfeedReviewUrlMatch {
  did: string;
  rkey: string;
}

// Same rules as @atproto/syntax's did.js/recordkey.js (see bsky-post-url.util.ts).
const DID_REGEX = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const RECORD_KEY_REGEX = /^[a-zA-Z0-9_~.:-]{1,512}$/;
const RECORD_KEY_INVALID_VALUES = new Set(['.', '..']);
const REVIEW_COLLECTION = 'social.popfeed.feed.review';
const ALLOWED_HOSTS = new Set(['popfeed.social', 'www.popfeed.social']);

function isValidRecordKey(value: string): boolean {
  return RECORD_KEY_REGEX.test(value) && !RECORD_KEY_INVALID_VALUES.has(value);
}

/** Real path-segment parsing -- the URL literally embeds the review's AT-URI. */
export function parsePopfeedReviewUrl(rawUrl: string): PopfeedReviewUrlMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;

  const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  if (segments.length !== 5) return null;
  const [reviewSeg, atSeg, did, collection, rkey] = segments;
  if (reviewSeg !== 'review' || atSeg !== 'at:' || collection !== REVIEW_COLLECTION) return null;
  if (!DID_REGEX.test(did) || !isValidRecordKey(rkey)) return null;

  return { did, rkey };
}
