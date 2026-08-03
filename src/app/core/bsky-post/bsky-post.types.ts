// Normalized, app-facing shapes for a native Bluesky post card -- mapped from
// the raw @atproto/api PostView/embed union (see bsky-post.mapper.ts) so the
// rendering components never deal with $type discrimination directly.

export interface BskyPostAuthor {
  did: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface BskyPostImage {
  thumb: string;
  fullsize: string;
  alt: string;
}

export interface BskyPostVideo {
  thumbnail: string | null;
  alt: string | null;
}

export interface BskyPostExternal {
  uri: string;
  title: string;
  description: string;
  thumb: string | null;
}

export type BskyQuoteTarget =
  | { kind: 'post'; post: BskyQuotedPost }
  | { kind: 'notFound' }
  | { kind: 'blocked' }
  | { kind: 'unavailable' }; // detached, or a non-post quote target (list/feed generator/labeler/starter pack)

// Media-only union -- deliberately excludes 'record'/'recordWithMedia' so a
// quoted post's own embed can never itself contain another quote. This makes
// "no recursion beyond 1 level" a compile-time property, not just a
// convention: BskyQuoteEmbedComponent has no data shape to recurse into.
export type BskyQuotedMediaEmbed =
  | { kind: 'images'; images: BskyPostImage[] }
  | { kind: 'video'; video: BskyPostVideo }
  | { kind: 'external'; external: BskyPostExternal };

export interface BskyQuotedPost {
  uri: string;
  cid: string;
  author: BskyPostAuthor;
  text: string;
  createdAt: string;
  embed: BskyQuotedMediaEmbed | null;
  replyCount: number;
  repostCount: number;
  likeCount: number;
}

// Top-level post's embed can be media, a quote, or a quote+media combo.
export type BskyPostEmbed =
  | { kind: 'images'; images: BskyPostImage[] }
  | { kind: 'video'; video: BskyPostVideo }
  | { kind: 'external'; external: BskyPostExternal }
  | { kind: 'quote'; quote: BskyQuoteTarget }
  | { kind: 'quoteWithMedia'; quote: BskyQuoteTarget; media: BskyQuotedMediaEmbed };

export interface BskyPostView {
  uri: string;
  cid: string;
  author: BskyPostAuthor;
  text: string;
  createdAt: string;
  embed: BskyPostEmbed | null;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  quoteCount: number;
  /** AT-URI of the current user's own like record, if any -- null when unliked or unauthenticated. */
  viewerLikeUri: string | null;
  /** AT-URI of the current user's own repost record, if any -- null when not reposted or unauthenticated. */
  viewerRepostUri: string | null;
}
