import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { EmbedPreferencesRecord } from './embed-preferences.types';

function cacheKey(did: string): string {
  return `embed_prefs.${did}`;
}

@Injectable({ providedIn: 'root' })
export class EmbedPreferencesCacheRepository {
  async getCached(did: string): Promise<EmbedPreferencesRecord | null> {
    const { value } = await Preferences.get({ key: cacheKey(did) });
    if (!value) return null;
    try {
      return JSON.parse(value) as EmbedPreferencesRecord;
    } catch {
      return null;
    }
  }

  async setCached(did: string, record: EmbedPreferencesRecord): Promise<void> {
    await Preferences.set({ key: cacheKey(did), value: JSON.stringify(record) });
  }

  async clearCached(did: string): Promise<void> {
    await Preferences.remove({ key: cacheKey(did) });
  }
}
