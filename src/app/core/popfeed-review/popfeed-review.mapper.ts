import type { BskyPostAuthor } from '../bsky-post/bsky-post.types';
import type { PopfeedReviewView } from './popfeed-review.types';

interface RawProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

// Converts the record's crossPosts.bluesky AT-URI (at://<did>/app.bsky.feed.post/<rkey>)
// into a canonical bsky.app web URL, reusing BskyPostCardComponent unmodified.
function toCrossPostUrl(crossPosts: unknown): string | null {
  if (typeof crossPosts !== 'object' || crossPosts === null) return null;
  const bluesky = (crossPosts as { bluesky?: unknown }).bluesky;
  if (typeof bluesky !== 'string') return null;

  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(bluesky);
  if (!match) return null;
  const [, did, rkey] = match;
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export function toPopfeedReviewView(uri: string, value: Record<string, unknown>, author: RawProfile): PopfeedReviewView {
  const mappedAuthor: BskyPostAuthor = {
    did: author.did,
    handle: author.handle,
    displayName: author.displayName ?? null,
    avatarUrl: author.avatar ?? null,
  };

  return {
    uri,
    author: mappedAuthor,
    title: typeof value['title'] === 'string' ? value['title'] : '',
    text: typeof value['text'] === 'string' ? value['text'] : '',
    rating: typeof value['rating'] === 'number' ? value['rating'] : null,
    genres: Array.isArray(value['genres']) ? value['genres'].filter((g): g is string => typeof g === 'string') : [],
    creativeWorkType: typeof value['creativeWorkType'] === 'string' ? value['creativeWorkType'] : '',
    posterUrl: typeof value['posterUrl'] === 'string' ? value['posterUrl'] : null,
    backdropUrl: typeof value['backdropUrl'] === 'string' ? value['backdropUrl'] : null,
    containsSpoilers: value['containsSpoilers'] === true,
    isRevisit: value['isRevisit'] === true,
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date().toISOString(),
    crossPostUrl: toCrossPostUrl(value['crossPosts']),
  };
}
