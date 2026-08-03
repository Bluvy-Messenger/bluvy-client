import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set(['open.spotify.com', 'www.open.spotify.com']);
const KINDS = new Set(['track', 'album', 'playlist', 'episode', 'show']);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export const spotifyProvider: EmbedProvider = {
  id: 'spotify',
  label: 'Spotify',
  embeddable: true,
  // No Spotify logo mark in the installed ionicons set -- a fitting neutral
  // icon paired with the brand color still reads as intentional.
  icon: 'musical-notes-outline',
  accentColor: '#1DB954',

  match(url: URL): EmbedMatch | null {
    if (!ALLOWED_HOSTS.has(url.hostname)) return null;

    let segments = url.pathname.split('/').filter(Boolean);
    // Locale-prefixed URLs, e.g. /intl-fr/track/<id>.
    if (segments[0]?.startsWith('intl-')) segments = segments.slice(1);

    const [kind, id] = segments;
    if (!kind || !KINDS.has(kind) || !id || !SPOTIFY_ID.test(id)) return null;

    return { provider: 'spotify', embedId: id, kind };
  },

  buildEmbedUrl(match: EmbedMatch): string {
    return `https://open.spotify.com/embed/${match.kind}/${match.embedId}`;
  },
};
