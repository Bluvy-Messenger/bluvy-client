import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const KEYS = {
  ACTIVE_DID:    'auth.activeDid',
  ACCESS_TOKEN:  'auth.accessToken',
  REFRESH_TOKEN: 'auth.refreshToken',
} as const;

@Injectable({ providedIn: 'root' })
export class TokenRepository {
  private activeDid: string | null = null;

  async getActiveDid(): Promise<string | null> {
    if (this.activeDid) return this.activeDid;
    const { value } = await Preferences.get({ key: KEYS.ACTIVE_DID });
    this.activeDid = value;
    return value;
  }

  async setActiveDid(did: string | null): Promise<void> {
    this.activeDid = did;
    if (did) {
      await Preferences.set({ key: KEYS.ACTIVE_DID, value: did });
    } else {
      await Preferences.remove({ key: KEYS.ACTIVE_DID });
    }
  }

  async setAccessToken(token: string, did?: string): Promise<void> {
    const targetDid = did || await this.getActiveDid();
    if (!targetDid) {
      await Preferences.set({ key: KEYS.ACCESS_TOKEN, value: token });
      return;
    }
    await Preferences.set({ key: `${KEYS.ACCESS_TOKEN}.${targetDid}`, value: token });
  }

  async getAccessToken(did?: string): Promise<string | null> {
    const targetDid = did || await this.getActiveDid();
    if (!targetDid) {
      const { value } = await Preferences.get({ key: KEYS.ACCESS_TOKEN });
      return value;
    }
    const { value } = await Preferences.get({ key: `${KEYS.ACCESS_TOKEN}.${targetDid}` });
    return value;
  }

  async setRefreshToken(token: string, did?: string): Promise<void> {
    const targetDid = did || await this.getActiveDid();
    if (!targetDid) {
      await Preferences.set({ key: KEYS.REFRESH_TOKEN, value: token });
      return;
    }
    await Preferences.set({ key: `${KEYS.REFRESH_TOKEN}.${targetDid}`, value: token });
  }

  async getRefreshToken(did?: string): Promise<string | null> {
    const targetDid = did || await this.getActiveDid();
    if (!targetDid) {
      const { value } = await Preferences.get({ key: KEYS.REFRESH_TOKEN });
      return value;
    }
    const { value } = await Preferences.get({ key: `${KEYS.REFRESH_TOKEN}.${targetDid}` });
    return value;
  }

  async clearTokens(did?: string): Promise<void> {
    const targetDid = did || await this.getActiveDid();
    if (!targetDid) {
      await Promise.all([
        Preferences.remove({ key: KEYS.ACCESS_TOKEN }),
        Preferences.remove({ key: KEYS.REFRESH_TOKEN }),
      ]);
      return;
    }
    await Promise.all([
      Preferences.remove({ key: `${KEYS.ACCESS_TOKEN}.${targetDid}` }),
      Preferences.remove({ key: `${KEYS.REFRESH_TOKEN}.${targetDid}` }),
    ]);
  }
}

