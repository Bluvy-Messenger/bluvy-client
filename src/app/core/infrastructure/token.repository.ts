import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const KEYS = {
  ACCESS_TOKEN:  'auth.accessToken',
  REFRESH_TOKEN: 'auth.refreshToken',
} as const;

@Injectable({ providedIn: 'root' })
export class TokenRepository {
  async setAccessToken(token: string): Promise<void> {
    await Preferences.set({ key: KEYS.ACCESS_TOKEN, value: token });
  }

  async getAccessToken(): Promise<string | null> {
    const { value } = await Preferences.get({ key: KEYS.ACCESS_TOKEN });
    return value;
  }

  async setRefreshToken(token: string): Promise<void> {
    await Preferences.set({ key: KEYS.REFRESH_TOKEN, value: token });
  }

  async getRefreshToken(): Promise<string | null> {
    const { value } = await Preferences.get({ key: KEYS.REFRESH_TOKEN });
    return value;
  }

  async clearTokens(): Promise<void> {
    await Promise.all([
      Preferences.remove({ key: KEYS.ACCESS_TOKEN }),
      Preferences.remove({ key: KEYS.REFRESH_TOKEN }),
    ]);
  }

}
