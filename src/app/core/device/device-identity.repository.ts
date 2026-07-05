import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

import type { StoredDeviceIdentity } from './device.types';
import { validateStoredDeviceIdentity } from './device.validator';

const NEW_KEY_PREFIX    = 'device.identity.';
const LEGACY_KEY_PREFIX = 'device.id.';

@Injectable({ providedIn: 'root' })
export class DeviceIdentityRepository {
  async getOrCreate(userDid: string): Promise<{ id: string; name: string; platform: string }> {
    const newKey = `${NEW_KEY_PREFIX}${userDid}`;

    const stored = await Preferences.get({ key: newKey });
    if (stored.value) {
      const identity = validateStoredDeviceIdentity(JSON.parse(stored.value));
      const meta = await this.getDeviceMetadata();
      return { id: identity.id, ...meta };
    }

    const legacyKey = `${LEGACY_KEY_PREFIX}${userDid}`;
    const legacy    = await Preferences.get({ key: legacyKey });
    const id        = legacy.value ?? crypto.randomUUID();

    await Preferences.set({
      key:   newKey,
      value: JSON.stringify({ id, createdAt: Date.now() } satisfies StoredDeviceIdentity),
    });

    if (legacy.value) {
      await Preferences.remove({ key: legacyKey });
    }

    const meta = await this.getDeviceMetadata();
    return { id, ...meta };
  }

  async get(userDid: string): Promise<{ id: string; name: string; platform: string } | null> {
    const stored = await Preferences.get({ key: `${NEW_KEY_PREFIX}${userDid}` });
    if (!stored.value) return null;
    const identity = validateStoredDeviceIdentity(JSON.parse(stored.value));
    const meta     = await this.getDeviceMetadata();
    return { id: identity.id, ...meta };
  }

  async clear(userDid: string): Promise<void> {
    await Preferences.remove({ key: `${NEW_KEY_PREFIX}${userDid}` });
  }

  async getDeviceMetadata(): Promise<{ name: string; platform: string }> {
    const platform = Capacitor.getPlatform();

    if (platform !== 'web') {
      try {
        const info = await Device.getInfo();
        const fallback = `${info.manufacturer ?? ''} ${info.model ?? ''}`.trim() || 'Device';
        const name     = info.name ?? fallback;
        return { name, platform };
      } catch {
        // Fall through to UA parsing.
      }
    }

    return { name: this.buildNameFromUA(), platform };
  }

  private buildNameFromUA(): string {
    const ua = navigator.userAgent;

    const browser =
      ua.includes('Edg/')     ? 'Edge'    :
      ua.includes('Chrome/')  ? 'Chrome'  :
      ua.includes('Firefox/') ? 'Firefox' :
      ua.includes('Safari/')  ? 'Safari'  : 'Browser';

    const os =
      ua.includes('Windows')                        ? 'Windows' :
      ua.includes('Mac OS')                         ? 'macOS'   :
      ua.includes('Android')                        ? 'Android' :
      ua.includes('iPhone') || ua.includes('iPad')  ? 'iOS'     :
      ua.includes('Linux')                          ? 'Linux'   : '';

    return os ? `${browser} on ${os}` : browser;
  }
}
