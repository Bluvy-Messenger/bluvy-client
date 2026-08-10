import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

function cacheKey(did: string): string {
  return `declaration_verified_at.${did}`;
}

/**
 * Persists (via Capacitor Preferences, so it survives app relaunches --
 * unlike sessionStorage) the last time com.bluvy.declaration was actually
 * read back from the PDS and checked for drift, so KeyPackageService can
 * throttle that check to once per hour instead of on every app launch.
 */
@Injectable({ providedIn: 'root' })
export class DeclarationVerificationCacheRepository {
  async getLastVerifiedAt(did: string): Promise<number> {
    const { value } = await Preferences.get({ key: cacheKey(did) });
    const parsed = value ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async setVerifiedNow(did: string): Promise<void> {
    await Preferences.set({ key: cacheKey(did), value: String(Date.now()) });
  }
}
