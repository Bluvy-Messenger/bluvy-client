import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { ConversationsService } from '../conversation/conversations.service';
import { SyncService } from '../sync/sync.service';
import { DeviceRepository } from './device.repository';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo }  from './device.types';

@Injectable({ providedIn: 'root' })
export class DeviceProvisioningService {
  private deviceRepo  = inject(DeviceRepository);
  private coordinator = inject(MlsCoordinatorBase);
  private convSvc     = inject(ConversationsService);
  private syncSvc     = inject(SyncService);

  async handleDeviceNew(
    newDeviceId: string,
    user:        UserProfile,
    device:      DeviceInfo,
  ): Promise<void> {
    await this.syncSvc.flush();

    let conversations: Array<{ id: string }>;
    try {
      const page = await firstValueFrom(this.convSvc.getConversations(undefined, 100));
      conversations = page.data;
    } catch (err) {
      if (!environment.production) console.warn('[DeviceProvisioning] handleDeviceNew: failed to load conversations', err);
      return;
    }

    for (const conv of conversations) {
      if (!await this.coordinator.canProvision(conv.id, user, device)) continue;
      try {
        await this.coordinator.provisionDevice(newDeviceId, conv.id, user, device);
      } catch (err) {
        if (!environment.production) console.warn('[DeviceProvisioning] handleDeviceNew: failed for conv', conv.id, ':', err);
      }
    }
  }

  private provisioning = false;

  async checkAndProvisionOnConnect(
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    if (this.provisioning) return;
    this.provisioning = true;
    try {
      await this._checkAndProvisionOnConnect(user, device);
    } finally {
      this.provisioning = false;
    }
  }

  private async _checkAndProvisionOnConnect(
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    await this.syncSvc.flush();

    let otherDeviceIds: string[];
    try {
      const resp = await this.deviceRepo.getMyDevices();
      otherDeviceIds = resp.data.map(d => d.id).filter(id => id !== device.id);
    } catch (err) {
      if (!environment.production) console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed to load devices', err);
      return;
    }
    if (otherDeviceIds.length === 0) return;

    let conversations: Array<{ id: string }>;
    try {
      const page = await firstValueFrom(this.convSvc.getConversations(undefined, 100));
      conversations = page.data;
    } catch (err) {
      if (!environment.production) console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed to load conversations', err);
      return;
    }

    for (const otherId of otherDeviceIds) {
      for (const conv of conversations) {
        if (!await this.coordinator.canProvision(conv.id, user, device)) continue;
        try {
          await this.coordinator.provisionDevice(otherId, conv.id, user, device);
        } catch (err) {
          if (!environment.production) console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed for device', otherId, 'conv', conv.id, ':', err);
        }
      }
    }
  }
}
