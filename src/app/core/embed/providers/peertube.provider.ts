import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const PEERTUBE_WATCH_REGEX = /^\/(?:w|videos\/watch)\/([a-zA-Z0-9_-]+)/;
const PEERTUBE_EMBED_REGEX = /^\/videos\/embed\/([a-zA-Z0-9_-]+)/;

export const peertubeProvider: EmbedProvider = {
  id: 'peertube',
  label: 'PeerTube',
  embeddable: true,
  icon: 'play-circle-outline',
  accentColor: '#F1680D',

  match(url: URL): EmbedMatch | null {
    const watchMatch = url.pathname.match(PEERTUBE_WATCH_REGEX);
    const embedMatch = url.pathname.match(PEERTUBE_EMBED_REGEX);
    const videoId = watchMatch?.[1] || embedMatch?.[1];

    if (!videoId) return null;

    return {
      provider: 'peertube',
      embedId: videoId,
      kind: url.host,
    };
  },

  buildEmbedUrl(match: EmbedMatch): string {
    const host = match.kind ?? '';
    return `https://${host}/videos/embed/${match.embedId}`;
  },
};
