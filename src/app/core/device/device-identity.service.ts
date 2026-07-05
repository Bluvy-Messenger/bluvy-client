import { Injectable, inject } from '@angular/core';
import { DeviceIdentityRepository } from './device-identity.repository';
import type { DeviceInfo, StoredDeviceIdentity } from './device.types';

export type { DeviceInfo, StoredDeviceIdentity } from './device.types';

@Injectable({ providedIn: 'root' })
export class DeviceIdentityService {
  private repo = inject(DeviceIdentityRepository);

  async getOrCreate(userDid: string): Promise<DeviceInfo> {
    return this.repo.getOrCreate(userDid);
  }

  async get(userDid: string): Promise<DeviceInfo | null> {
    return this.repo.get(userDid);
  }

  async clear(userDid: string): Promise<void> {
    return this.repo.clear(userDid);
  }

  async getDeviceMetadata(): Promise<{ name: string; platform: string }> {
    return this.repo.getDeviceMetadata();
  }
}
