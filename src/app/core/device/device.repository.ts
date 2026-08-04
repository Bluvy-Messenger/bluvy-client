import { Injectable, inject } from '@angular/core';
import { ApiClientService } from '../infrastructure/api-client.service';
import { validateDeviceItemsResponse, validateRevokedDeviceItemsResponse, validatePendingProvisionItemsResponse } from './device.validator';

export interface DeviceItem {
  id:        string;
  name:      string;
  platform:  string;
  lastSeen:  number;
  createdAt: number;
}

export interface RevokedDeviceItem {
  id:      string;
  userDid: string;
}

export interface PendingProvisionItem {
  deviceId:       string;
  conversationId: string;
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

  // Every revoked device belonging to anyone the caller shares a conversation
  // with (self included) -- see the backend's getRevokedDevicesInMyConversations
  // for why (forensic audit finding F11).
  async getRevokedDevices(): Promise<{ data: RevokedDeviceItem[] }> {
    const raw = await this.apiClient.get<{ data: RevokedDeviceItem[] }>('/v1/devices/revoked');
    return validateRevokedDeviceItemsResponse(raw);
  }

  // Every (deviceId, conversationId) pair among the caller's own other active
  // devices that still needs an MLS Welcome for that conversation -- see
  // DeviceProvisioningService.checkAndProvisionOnConnect.
  async getPendingProvisions(): Promise<{ data: PendingProvisionItem[] }> {
    const raw = await this.apiClient.get<{ data: PendingProvisionItem[] }>('/v1/devices/pending-provisions');
    return validatePendingProvisionItemsResponse(raw);
  }
}
