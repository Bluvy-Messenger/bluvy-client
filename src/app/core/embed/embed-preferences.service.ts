import { Injectable, inject, signal } from '@angular/core';
import { OAuthService } from '../auth/oauth.service';
import { AtprotoRepoService } from '../auth/atproto-repo.service';
import { EmbedPreferencesCacheRepository } from './embed-preferences-cache.repository';
import { EmbedPreferencesRecord } from './embed-preferences.types';
import { EmbedProviderId } from './embed-provider.types';
import { EMBED_PROVIDER_DEFAULTS } from './embed-preferences.defaults';

const SCHEMA_VERSION = 1;

function mergeWithDefaults(record: EmbedPreferencesRecord | null): Record<EmbedProviderId, boolean> {
  const merged = { ...EMBED_PROVIDER_DEFAULTS };
  if (!record || record.schemaVersion > SCHEMA_VERSION) return merged;

  // Iterate over the app's own known-provider list, never the record's keys —
  // this is what keeps a newly-added provider OFF for accounts whose cached
  // record predates it, instead of silently defaulting to true.
  for (const key of Object.keys(EMBED_PROVIDER_DEFAULTS) as EmbedProviderId[]) {
    const value = record.providers?.[key];
    if (typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

@Injectable({ providedIn: 'root' })
export class EmbedPreferencesService {
  private oauth = inject(OAuthService);
  private repo  = inject(AtprotoRepoService);
  private cache = inject(EmbedPreferencesCacheRepository);

  readonly preferences = signal<Record<EmbedProviderId, boolean>>({ ...EMBED_PROVIDER_DEFAULTS });
  readonly loadState    = signal<'idle' | 'cache' | 'synced' | 'stale-fallback'>('idle');

  private lastCachedRecord: EmbedPreferencesRecord | null = null;

  isEnabled(provider: EmbedProviderId): boolean {
    return this.preferences()[provider];
  }

  /** Fast, local-only load — must never block on network. */
  async bootstrap(): Promise<void> {
    const did = this.oauth.session?.sub;
    if (!did) return;

    const cached = await this.cache.getCached(did);
    if (cached) {
      this.lastCachedRecord = cached;
      this.preferences.set(mergeWithDefaults(cached));
      this.loadState.set('cache');
    } else {
      this.loadState.set('idle');
    }
  }

  /** Background refresh from the user's PDS — fire-and-forget from callers. */
  async refreshFromPds(): Promise<void> {
    const did = this.oauth.session?.sub;
    if (!did) return;

    const record = await this.repo.getEmbedPreferences();

    if (record) {
      this.lastCachedRecord = record;
      this.preferences.set(mergeWithDefaults(record));
      this.loadState.set('synced');
      await this.cache.setCached(did, record);
      return;
    }

    // Record not found or PDS unreachable — never treat as "allow everything".
    if (this.lastCachedRecord) return; // keep whatever the cache already applied
    this.preferences.set({ ...EMBED_PROVIDER_DEFAULTS });
    this.loadState.set('stale-fallback');
  }

  /**
   * "Always allow" — persists to the PDS. Distinct from a session-only
   * "load once" override, which never touches this service or the PDS.
   */
  async setAlwaysAllow(provider: EmbedProviderId, enabled: boolean): Promise<void> {
    const did = this.oauth.session?.sub;
    if (!did) throw new Error('No active ATProto session');

    const nextProviders = { ...this.preferences(), [provider]: enabled };
    this.preferences.set(nextProviders); // instant UI feedback

    const record: EmbedPreferencesRecord = {
      $type: 'com.bluvy.preferences.embeds',
      schemaVersion: SCHEMA_VERSION,
      providers: nextProviders,
      updatedAt: new Date().toISOString(),
    };

    await this.repo.putEmbedPreferences(record); // only cache on confirmed persistence
    this.lastCachedRecord = record;
    await this.cache.setCached(did, record);
  }
}
