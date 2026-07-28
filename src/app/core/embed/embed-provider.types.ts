export type EmbedProviderId = 'youtube' | 'spotify' | 'dailymotion' | 'tiktok' | 'twitch' | 'gif';

export interface EmbedMatch {
  provider: EmbedProviderId;
  embedId: string;
  kind?: string;
}

export interface EmbedProvider {
  readonly id: EmbedProviderId;
  readonly label: string;
  // false = never rendered live (no live embed method available yet); only a
  // branded fallback card + "open externally" link is ever shown for this provider.
  readonly embeddable: boolean;
  readonly renderKind: 'iframe' | 'image';

  /** Real hostname + path/query parsing against an allow-list. Never substring matching. */
  match(url: URL): EmbedMatch | null;

  /** Reconstructs a safe embed src URL from an already-validated EmbedMatch — never from raw message text. */
  buildEmbedUrl(match: EmbedMatch): string;
}
