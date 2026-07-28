import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const VIEW_HOSTS = new Set(['giphy.com', 'www.giphy.com']);
const GIPHY_ID = /^[A-Za-z0-9]{10,32}$/;
const MEDIA_EXTENSION = /\.(gif|webp|mp4)$/i;

function isCdnHost(hostname: string): boolean {
  return hostname.endsWith('.giphy.com') && !VIEW_HOSTS.has(hostname);
}

// Giphy's official "Embed" share option is a plain, unauthenticated iframe
// (giphy.com/embed/<id>) -- no API key or oEmbed round trip needed, unlike
// Tenor, which requires an authenticated API call to resolve a view-page
// link to its actual media. This lets GIF embeds follow the same
// client-reconstructed-iframe pattern as every other provider.
export const giphyProvider: EmbedProvider = {
  id: 'gif',
  label: 'GIF',
  embeddable: true,
  icon: 'image-outline',
  accentColor: '#00C48C',

  match(url: URL): EmbedMatch | null {
    const segments = url.pathname.split('/').filter(Boolean);

    if (VIEW_HOSTS.has(url.hostname)) {
      if (segments[0] === 'embed' && segments[1] && GIPHY_ID.test(segments[1])) {
        return { provider: 'gif', embedId: segments[1] };
      }
      if ((segments[0] === 'gifs' || segments[0] === 'clips') && segments[1]) {
        const id = segments[1].split('-').pop() ?? '';
        if (GIPHY_ID.test(id)) return { provider: 'gif', embedId: id };
      }
      return null;
    }

    if (isCdnHost(url.hostname)) {
      if (segments[0] === 'media' && segments[1] && GIPHY_ID.test(segments[1])) {
        return { provider: 'gif', embedId: segments[1] };
      }
      if (segments.length === 1 && MEDIA_EXTENSION.test(segments[0])) {
        const id = segments[0].replace(MEDIA_EXTENSION, '');
        if (GIPHY_ID.test(id)) return { provider: 'gif', embedId: id };
      }
    }

    return null;
  },

  buildEmbedUrl(match: EmbedMatch): string {
    return `https://giphy.com/embed/${match.embedId}`;
  },
};
