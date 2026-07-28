import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'www.youtu.be',
]);

const VIDEO_ID = /^[\w-]{11}$/;

export const youtubeProvider: EmbedProvider = {
  id: 'youtube',
  label: 'YouTube',
  embeddable: true,
  icon: 'logo-youtube',
  accentColor: '#FF0000',

  match(url: URL): EmbedMatch | null {
    if (!ALLOWED_HOSTS.has(url.hostname)) return null;

    let id: string | null = null;

    if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] === 'watch') {
        id = url.searchParams.get('v');
      } else if (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'live') {
        id = segments[1] ?? null;
      }
    }

    if (!id || !VIDEO_ID.test(id)) return null;
    return { provider: 'youtube', embedId: id };
  },

  buildEmbedUrl(match: EmbedMatch): string {
    // Privacy-enhanced mode is used unconditionally, per requirement.
    return `https://www.youtube-nocookie.com/embed/${match.embedId}`;
  },
};
