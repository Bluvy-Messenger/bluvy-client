import { Injectable } from '@angular/core';
import { EmbedMatch, EmbedProvider, EmbedProviderId } from './embed-provider.types';
import { youtubeProvider } from './providers/youtube.provider';
import { spotifyProvider } from './providers/spotify.provider';
import { dailymotionProvider } from './providers/dailymotion.provider';
import { tiktokProvider } from './providers/tiktok.provider';
import { twitchProvider } from './providers/twitch.provider';
import { peertubeProvider } from './providers/peertube.provider';
import { giphyProvider } from './providers/giphy.provider';

@Injectable({ providedIn: 'root' })
export class EmbedRegistry {
  private readonly providers: EmbedProvider[] = [
    youtubeProvider,
    spotifyProvider,
    dailymotionProvider,
    tiktokProvider,
    twitchProvider,
    peertubeProvider,
    giphyProvider,
  ];

  /** Real URL parsing against each provider's hostname allow-list — never substring matching. */
  detect(rawUrl: string): EmbedMatch | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    for (const provider of this.providers) {
      const match = provider.match(url);
      if (match) return match;
    }
    return null;
  }

  get(id: EmbedProviderId): EmbedProvider {
    const provider = this.providers.find(p => p.id === id);
    if (!provider) throw new Error(`Unknown embed provider: ${id}`);
    return provider;
  }
}
