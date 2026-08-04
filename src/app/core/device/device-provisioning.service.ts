import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
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
    reason:      'new' | 'lost_state' = 'new',
  ): Promise<void> {
    await this.syncSvc.flush();

    let conversationCount = 0;
    await this.forEachConversation(async (conv) => {
      conversationCount++;
      if (!await this.coordinator.canProvision(conv.id, user, device)) return;
      try {
        if (reason === 'lost_state') {
          // See Phase 8b / AUDIT_02 Root Cause #3: this device already has a
          // leaf in the MLS tree (it consumed a Welcome before), so a plain
          // add-commit would no-op on the "already a member" guard. A
          // Remove+Add commit in a single step kicks the stale leaf and
          // re-adds it fresh, producing a new Welcome.
          await this.coordinator.reprovisionLostStateDevice(newDeviceId, conv.id, user, device);
        } else {
          await this.coordinator.provisionDevice(newDeviceId, conv.id, user, device);
        }
      } catch (err) {
        console.warn('[DeviceProvisioning] handleDeviceNew: failed for conv', conv.id, ':', err);
      }
    });

    console.log('[MLS:observability] handleDeviceNew', { newDeviceId, reason, conversationCount });
  }

  // Iterates every conversation for the account, across both archived states,
  // with proper cursor pagination. Shared by every provisioning path so none
  // of them silently stop past the first page or skip archived conversations
  // (forensic audit finding F4) -- getConversations() defaults to non-archived
  // only, and a single page(undefined, 100) call permanently excludes any
  // conversation beyond the first 100 and every archived one, with no retry,
  // error, or signal.
  private async forEachConversation(cb: (conv: { id: string }) => Promise<void>): Promise<void> {
    const seen = new Set<string>();

    for (const archived of [false, true]) {
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await firstValueFrom(this.convSvc.getConversations(cursor, 100, archived));
        } catch (err) {
          console.warn('[DeviceProvisioning] forEachConversation: failed to load conversations page', err);
          break;
        }

        for (const conv of page.data) {
          if (seen.has(conv.id)) continue;
          seen.add(conv.id);
          await cb(conv);
        }

        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor);
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

    console.log('[MLS:observability] proactiveCatchUpSweep start', { userDid: user.did, deviceId: device.id });

    let conversationsSwept = 0;
    await this.forEachConversation(async (conv) => {
      conversationsSwept++;
      try {
        // No-op if there's no local group state yet, or if already caught up
        // (see MlsService.catchUpMissedCommits) -- safe to call unconditionally.
        await this.coordinator.catchUpMissedCommits(conv.id, user, device);
      } catch (err) {
        console.warn('[DeviceProvisioning] proactiveCatchUpSweep: failed for conv', conv.id, ':', err);
      }
    });

    console.log('[MLS:observability] proactiveCatchUpSweep done', { userDid: user.did, conversationsSwept });
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

    // Independent of the own-device provisioning below (not gated on
    // otherDeviceIds.length): a revoked device needing leaf removal is just
    // as often a conversation partner's device as one of this account's own.
    await this.removeRevokedDeviceLeaves(user, device);

    let otherDeviceIds: string[];
    try {
      const resp = await this.deviceRepo.getMyDevices();
      otherDeviceIds = resp.data.map(d => d.id).filter(id => id !== device.id);
    } catch (err) {
      console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed to load devices', err);
      return;
    }
    if (otherDeviceIds.length === 0) return;

    await this.forEachConversation(async (conv) => {
      for (const otherId of otherDeviceIds) {
        if (!await this.coordinator.canProvision(conv.id, user, device)) continue;
        try {
          await this.coordinator.provisionDevice(otherId, conv.id, user, device);
        } catch (err) {
          console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed for device', otherId, 'conv', conv.id, ':', err);
        }
      }
    });
  }

  // Forensic audit finding F11: device:revoked is an ephemeral socket event
  // with no durable replay -- a revocation that happens while every member is
  // offline is otherwise never retried, leaving the revoked device's leaf in
  // the MLS tree indefinitely. Re-checks the full list on reconnect;
  // removeRevokedDeviceFromAllGroups() is idempotent (a no-op once the leaf
  // is already gone), which is cheap ONLY when removals are actually
  // succeeding. If a leaf keeps failing to remove (e.g. a real ts-mls
  // conflict), reconnects can happen every 1-5s (Socket.IO's default
  // reconnection backoff, unbounded attempts -- see socket.service.ts) and
  // this sweep re-attempts EVERY revoked device across EVERY conversation
  // each time, each device costing at least one acquireCommitLock call. A
  // backlog of a dozen+ stuck devices turns "reconnect happened" into a
  // burst of 60-80+ requests, repeated every few seconds -- observed in
  // production as a request storm hitting rate limits. This cooldown caps
  // that to once per interval regardless of reconnect frequency.
  private lastRevokedSweepAt = 0;
  private static readonly REVOKED_SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;

  private async removeRevokedDeviceLeaves(user: UserProfile, device: DeviceInfo): Promise<void> {
    const now = Date.now();
    if (now - this.lastRevokedSweepAt < DeviceProvisioningService.REVOKED_SWEEP_MIN_INTERVAL_MS) return;
    this.lastRevokedSweepAt = now;

    let revoked: Array<{ id: string }>;
    try {
      const resp = await this.deviceRepo.getRevokedDevices();
      revoked = resp.data;
    } catch (err) {
      console.warn('[DeviceProvisioning] removeRevokedDeviceLeaves: failed to load revoked devices', err);
      return;
    }

    for (const revokedDevice of revoked) {
      try {
        await this.coordinator.removeRevokedDeviceFromAllGroups(revokedDevice.id, user, device);
      } catch (err) {
        console.warn('[DeviceProvisioning] removeRevokedDeviceLeaves: failed for device', revokedDevice.id, ':', err);
      }
    }
  }
}
