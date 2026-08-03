import type { BskyPostAuthor } from '../bsky-post/bsky-post.types';

export type PopfeedCreativeWorkType = 'movie' | 'tv_show' | 'video_game' | 'book' | (string & {});

export interface PopfeedReviewView {
  uri: string;
  author: BskyPostAuthor;
  title: string;
  text: string;
  rating: number | null;
  genres: string[];
  creativeWorkType: PopfeedCreativeWorkType;
  posterUrl: string | null;
  backdropUrl: string | null;
  containsSpoilers: boolean;
  isRevisit: boolean;
  createdAt: string;
  /** Reconstructed https://bsky.app/profile/<did>/post/<rkey> from the record's crossPosts.bluesky AT-URI -- null if absent/unrecognized. */
  crossPostUrl: string | null;
}
