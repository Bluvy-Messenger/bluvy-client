import { EmbedMatch, EmbedProvider } from '../embed-provider.types';

const ALLOWED_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com']);
const VIDEO_PATH = /^\/@[\w.-]+\/video\/(\d+)$/;
const SHORT_CODE = /^[\w-]+$/;

// TikTok's only official embed method requires loading a remote script
// (tiktok.com/embed.js) into the message-rendering context, which is a
// different trust/network profile than every other provider's plain iframe.
// Detection still runs so a TikTok link gets a branded fallback card instead
// of the generic link-preview card, but no live embed is ever rendered.
export const tiktokProvider: EmbedProvider = {
  id: 'tiktok',
  label: 'TikTok',
  embeddable: false,
  renderKind: 'iframe',

  match(url: URL): EmbedMatch | null {
    if (!ALLOWED_HOSTS.has(url.hostname)) return null;

    if (url.hostname === 'vm.tiktok.com') {
      const code = url.pathname.split('/').filter(Boolean)[0];
      if (!code || !SHORT_CODE.test(code)) return null;
      return { provider: 'tiktok', embedId: code, kind: 'short' };
    }

    const match = VIDEO_PATH.exec(url.pathname);
    if (!match) return null;
    return { provider: 'tiktok', embedId: match[1], kind: 'video' };
  },

  buildEmbedUrl(): string {
    // Never actually called: embeddable is false, so MessageEmbedComponent
    // never requests a live embed URL for this provider.
    return '';
  },
};
