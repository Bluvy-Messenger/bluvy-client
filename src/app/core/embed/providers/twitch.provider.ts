import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'player.twitch.tv']);
const CHANNEL = /^[A-Za-z0-9_]{4,25}$/;
const CLIP_SLUG = /^[A-Za-z0-9_-]+$/;
const VIDEO_ID = /^\d+$/;

// Twitch's own top-level site paths that would otherwise pass the CHANNEL
// regex and be mistaken for a channel name (e.g. twitch.tv/directory).
const RESERVED_PATHS = new Set([
  'directory', 'downloads', 'jobs', 'turbo', 'prime', 'wallet', 'subscriptions',
  'settings', 'login', 'signup', 'logout', 'search', 'following', 'friends',
  'inventory', 'drops', 'dashboard', 'store', 'help', 'support', 'developers',
  'press', 'blog', 'mobile', 'payments', 'affiliate', 'partners', 'discover',
  'category', 'collections', 'privacy', 'terms', 'feedback', 'bits', 'extensions',
  'creators', 'security', 'moderation', 'community', 'about', 'teams', 'admin',
]);

export const twitchProvider: EmbedProvider = {
  id: 'twitch',
  label: 'Twitch',
  embeddable: true,
  icon: 'logo-twitch',
  accentColor: '#9146FF',

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

    // Bare channel URL (twitch.tv/<channel>) — a live-stream link, guarded by
    // RESERVED_PATHS so Twitch's own site paths aren't mistaken for channels.
    if (segments.length === 1 && CHANNEL.test(segments[0]) && !RESERVED_PATHS.has(segments[0].toLowerCase())) {
      return { provider: 'twitch', embedId: segments[0], kind: 'channel' };
    }

    return null;
  },

  buildEmbedUrl(match: EmbedMatch): string {
    const parent = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    if (match.kind === 'video') {
      return `https://player.twitch.tv/?video=${match.embedId}&parent=${parent}&autoplay=false`;
    }
    if (match.kind === 'channel') {
      return `https://player.twitch.tv/?channel=${match.embedId}&parent=${parent}&autoplay=false`;
    }
    return `https://clips.twitch.tv/embed?clip=${match.embedId}&parent=${parent}&autoplay=false`;
  },
};
