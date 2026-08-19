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

    let id: string | null = null;
    if (Capacitor.getPlatform() !== 'web') {
      try {
        const deviceIdObj = await Device.getId();
        if (deviceIdObj?.identifier) {
          id = await this.hashHardwareId(deviceIdObj.identifier, userDid);
        }
      } catch {
        // Fall back to legacy or random UUID
      }
    }

    if (!id) {
      const legacyKey = `${LEGACY_KEY_PREFIX}${userDid}`;
      const legacy    = await Preferences.get({ key: legacyKey });
      id              = legacy.value ?? crypto.randomUUID();
      if (legacy.value) {
        await Preferences.remove({ key: legacyKey });
      }
    }

    await this.writeIdentity(userDid, id);

    const meta = await this.getDeviceMetadata();
    return { id, ...meta };
  }

  private async hashHardwareId(identifier: string, userDid: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`bluvy-hw:${identifier}:${userDid}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  // Reconciles the locally stored deviceId with one the backend returned
  // (login/restore response), which can differ from what was requested --
  // e.g. a revoked device row doesn't match the backend's idempotent-reuse
  // filter, so a fresh id is minted server-side (see devices.service.ts
  // upsertActiveDevice). Without this, the stale local id would be resent on
  // every subsequent login, minting a new device row (and orphaning this
  // device's MLS state) each time.
  async persist(userDid: string, deviceId: string): Promise<void> {
    await this.writeIdentity(userDid, deviceId);
  }

  private async writeIdentity(userDid: string, id: string): Promise<void> {
    await Preferences.set({
      key:   `${NEW_KEY_PREFIX}${userDid}`,
      value: JSON.stringify({ id, createdAt: Date.now() } satisfies StoredDeviceIdentity),
    });
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
