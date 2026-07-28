import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const MEDIA_EXTENSION = /\.(gif|webp|mp4|png)$/i;

// Only direct Tenor CDN media URLs are supported (e.g. media.tenor.com/.../x.gif),
// which can be rendered as a plain <img> with no extra network round trip.
// tenor.com/view/... page links are intentionally not resolved here, since doing
// so would require an authenticated call to Tenor's API to look up the actual
// media URL — out of scope without a configured API key.
function isTenorMediaHost(hostname: string): boolean {
  return hostname !== 'tenor.com' && hostname !== 'www.tenor.com' && hostname.endsWith('.tenor.com');
}

export const tenorGifProvider: EmbedProvider = {
  id: 'gif',
  label: 'GIF',
  embeddable: true,
  renderKind: 'image',

  match(url: URL): EmbedMatch | null {
    if (!isTenorMediaHost(url.hostname)) return null;
    if (!MEDIA_EXTENSION.test(url.pathname)) return null;

    // No separate numeric ID exists for a direct CDN asset — the fully
    // validated (allow-listed host + extension) URL itself is the embedId.
    return { provider: 'gif', embedId: url.toString() };
  },

  buildEmbedUrl(match: EmbedMatch): string {
    return match.embedId;
  },
};
