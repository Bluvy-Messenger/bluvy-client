import type { EmbedRegistry } from '../embed/embed-registry.service';
import type { EmbedMatch } from '../embed/embed-provider.types';
import { parseBskyPostUrl } from '../bsky-post/bsky-post-url.util';
import { parsePopfeedReviewUrl } from '../popfeed-review/popfeed-review-url.util';

// http(s) URLs in the text, trimmed of trailing sentence punctuation (e.g.
// "check this out: https://example.com." shouldn't include the period).
const URL_REGEX = /https?:\/\/\S+/gi;
const TRAILING_PUNCTUATION = /[)\].,!?'"]+$/;

// Caps how many links in a single message get a preview -- a message
// pasted with dozens of links shouldn't trigger dozens of embeds/fetches.
const MAX_LINKS_PER_MESSAGE = 4;

export interface ExtractedUrl {
  url: string;
  /** The exact substring matched in the text, before punctuation trimming -- used to strip it out of displayed text. */
  rawMatch: string;
}

export function extractAllUrls(text: string): ExtractedUrl[] {
  const matches = text.match(URL_REGEX) ?? [];
  return matches.slice(0, MAX_LINKS_PER_MESSAGE).map(rawMatch => ({
    url: rawMatch.replace(TRAILING_PUNCTUATION, ''),
    rawMatch,
  }));
}

export type DetectedMessageLink =
  | { kind: 'bskyPost'; url: string }
  | { kind: 'popfeedReview'; url: string }
  | { kind: 'embed'; match: EmbedMatch; url: string }
  | { kind: 'generic'; url: string };

/**
 * Same detection order everywhere a message's link gets classified (sent
 * bubbles, the live pre-send composer preview): Bluesky post > Popfeed
 * review > provider embed (YouTube/Twitch/...) > generic OG-scraped preview.
 * Never more than one at once.
 */
export function classifyMessageLink(url: string, embedRegistry: EmbedRegistry): DetectedMessageLink {
  if (parseBskyPostUrl(url)) return { kind: 'bskyPost', url };
  if (parsePopfeedReviewUrl(url)) return { kind: 'popfeedReview', url };

  const match = embedRegistry.detect(url);
  if (match) return { kind: 'embed', match, url };

  return { kind: 'generic', url };
}
