import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'player.twitch.tv']);
const CHANNEL = /^[A-Za-z0-9_]{4,25}$/;
const CLIP_SLUG = /^[A-Za-z0-9_-]+$/;
const VIDEO_ID = /^\d+$/;

export const twitchProvider: EmbedProvider = {
  id: 'twitch',
  label: 'Twitch',
  embeddable: true,
  renderKind: 'iframe',

  match(url: URL): EmbedMatch | null {
    if (!ALLOWED_HOSTS.has(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean);

    if (url.hostname === 'clips.twitch.tv') {
      const slug = segments[0];
      if (!slug || !CLIP_SLUG.test(slug)) return null;
      return { provider: 'twitch', embedId: slug, kind: 'clip' };
    }

    // twitch.tv/videos/<id>
    if (segments[0] === 'videos' && segments[1] && VIDEO_ID.test(segments[1])) {
      return { provider: 'twitch', embedId: segments[1], kind: 'video' };
    }

    // twitch.tv/<channel>/clip/<slug>
    if (segments.length === 3 && segments[1] === 'clip' && CHANNEL.test(segments[0]) && CLIP_SLUG.test(segments[2])) {
      return { provider: 'twitch', embedId: segments[2], kind: 'clip' };
    }

    // Bare channel URLs (twitch.tv/<channel>) are intentionally not matched —
    // too broad a surface to distinguish from arbitrary reserved paths safely.
    return null;
  },

  buildEmbedUrl(match: EmbedMatch): string {
    const parent = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    if (match.kind === 'video') {
      return `https://player.twitch.tv/?video=${match.embedId}&parent=${parent}&autoplay=false`;
    }
    return `https://clips.twitch.tv/embed?clip=${match.embedId}&parent=${parent}&autoplay=false`;
  },
};
