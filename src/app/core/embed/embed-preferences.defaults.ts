import { EmbedProviderId } from './embed-provider.types';

// GIF is the sole provider enabled by default; every other provider is
// opt-in. New providers must be added here explicitly — an absent key in a
// fetched preferences record must never be treated as "true".
export const EMBED_PROVIDER_DEFAULTS: Record<EmbedProviderId, boolean> = {
  youtube: false,
  spotify: false,
  dailymotion: false,
  tiktok: false,
  twitch: false,
  peertube: false,
  gif: true,
};
