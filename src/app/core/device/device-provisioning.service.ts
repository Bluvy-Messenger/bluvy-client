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

  // Proactive Recovery Sweep (Phase 6, see MLS_FINAL_IMPLEMENTATION_PLAN.md /
  // AUDIT_05_HISTORICAL_RECOVERY.md Category B). Runs at most once per user DID
  // per app process lifetime -- re-running on every session bootstrap would add
  // an unnecessary catch-up round trip per conversation on every cold start;
  // once per login/session-restore is enough to resolve any conversation that
  // fell behind before the applyCommit/catch-up fixes shipped.
  private sweptForDid = new Set<string>();

  async proactiveCatchUpSweep(
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    if (this.sweptForDid.has(user.did)) return;
    this.sweptForDid.add(user.did);

    const seen = new Set<string>();

    // getConversations() defaults to non-archived only (backend: `archived`
    // query param absent => false) -- sweep both so an archived-but-still-
    // frozen conversation isn't silently skipped.
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await firstValueFrom(this.convSvc.getConversations(cursor, 100, archived));
        } catch (err) {
          if (!environment.production) console.warn('[DeviceProvisioning] proactiveCatchUpSweep: failed to load conversations page', err);
          break;
        }

        for (const conv of page.data) {
          if (seen.has(conv.id)) continue;
          seen.add(conv.id);
          try {
            // No-op if there's no local group state yet, or if already caught up
            // (see MlsService.catchUpMissedCommits) -- safe to call unconditionally.
            await this.coordinator.catchUpMissedCommits(conv.id, user, device);
          } catch (err) {
            if (!environment.production) console.warn('[DeviceProvisioning] proactiveCatchUpSweep: failed for conv', conv.id, ':', err);
          }
        }

        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor);
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
