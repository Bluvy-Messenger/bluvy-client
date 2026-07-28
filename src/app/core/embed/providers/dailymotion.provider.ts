import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set(['dailymotion.com', 'www.dailymotion.com', 'dai.ly']);
const VIDEO_ID = /^[A-Za-z0-9]{4,14}$/;

export const dailymotionProvider: EmbedProvider = {
  id: 'dailymotion',
  label: 'Dailymotion',
  embeddable: true,
  renderKind: 'iframe',

  match(url: URL): EmbedMatch | null {
    if (!ALLOWED_HOSTS.has(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    let rawId: string | null = null;

    if (url.hostname === 'dai.ly') {
      rawId = segments[0] ?? null;
    } else if (segments[0] === 'video') {
      rawId = segments[1] ?? null;
    }
    if (!rawId) return null;

    // Strip an optional trailing slug, e.g. "x7tgad0_some-title_tech" -> "x7tgad0".
    const id = rawId.split(/[_-]/)[0];
    if (!VIDEO_ID.test(id)) return null;

    return { provider: 'dailymotion', embedId: id };
  },

  buildEmbedUrl(match: EmbedMatch): string {
    return `https://www.dailymotion.com/embed/video/${match.embedId}`;
  },
};
