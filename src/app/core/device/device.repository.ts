import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import { validateDeviceItemsResponse } from './device.validator';

export interface DeviceItem {
  id:        string;
  name:      string;
  platform:  string;
  lastSeen:  number;
  createdAt: number;
}

@Injectable({ providedIn: 'root' })
export class DeviceRepository {
  private apiClient = inject(ApiClientService);

  async getMyDevices(): Promise<{ data: DeviceItem[] }> {
    const raw = await this.apiClient.get<{ data: DeviceItem[] }>('/v1/devices/mine');
    return validateDeviceItemsResponse(raw);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.apiClient.delete<void>(`/v1/devices/${deviceId}`);
  }

  async revokeAllDevices(): Promise<{ revokedCount: number }> {
    return this.apiClient.delete<{ revokedCount: number }>('/v1/devices');
  }
}
