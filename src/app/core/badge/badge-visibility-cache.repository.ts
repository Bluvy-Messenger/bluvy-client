import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { BADGE_VISIBILITY_OPTIONS, type BadgeVisibility } from './badge-visibility.types';

function cacheKey(did: string): string {
  return `badge_visibility.${did}`;
}

@Injectable({ providedIn: 'root' })
export class BadgeVisibilityCacheRepository {
  async getCached(did: string): Promise<BadgeVisibility | null> {
    const { value } = await Preferences.get({ key: cacheKey(did) });
    if (!value) return null;
    return (BADGE_VISIBILITY_OPTIONS as string[]).includes(value)
      ? (value as BadgeVisibility)
      : null;
  }

  async setCached(did: string, value: BadgeVisibility): Promise<void> {
    await Preferences.set({ key: cacheKey(did), value });
  }
}
