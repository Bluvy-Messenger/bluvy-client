import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { MlsEpochConflictBus } from '../mls/mls-epoch-conflict-bus.service';
import { ConversationsService } from '../conversation/conversations.service';
import { SyncService } from '../sync/sync.service';
import { DeviceRepository } from './device.repository';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo }  from './device.types';

@Injectable({ providedIn: 'root' })
export class DeviceProvisioningService {
  private deviceRepo       = inject(DeviceRepository);
  private coordinator      = inject(MlsCoordinatorBase);
  private convSvc          = inject(ConversationsService);
  private syncSvc          = inject(SyncService);
  private epochConflictBus = inject(MlsEpochConflictBus);

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

    // Independent of the own-device provisioning below: a revoked device
    // needing leaf removal is just as often a conversation partner's device
    // as one of this account's own.
    await this.removeRevokedDeviceLeaves(user, device);

    // Precise, server-computed list instead of the old blind "every other own
    // device x every conversation" sweep -- see getPendingProvisions on the
    // backend. This also closes the gap where claimInitiatorSlot's device:new
    // nudge is an ephemeral socket event: if this device was offline when it
    // fired, nothing used to re-derive that another device was left waiting;
    // this list is re-read on every reconnect instead of relying on the nudge
    // having been received.
    let pending: Array<{ deviceId: string; conversationId: string }>;
    try {
      const resp = await this.deviceRepo.getPendingProvisions();
      pending = resp.data;
    } catch (err) {
      console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed to load pending provisions', err);
      return;
    }

    for (const { deviceId: otherId, conversationId } of pending) {
      if (!await this.coordinator.canProvision(conversationId, user, device)) continue;

      // AUDIT P1 (provisionDevice client/server divergence after network
      // failure): `pending` is server truth -- getPendingProvisions() only
      // lists a pair when no device_welcomes row exists for it, and a
      // confirmed commit always writes that row in the same transaction
      // (mls.service.ts storeMlsCommit). So if local state already
      // believes otherId is a member of conversationId, the ONLY way that
      // can happen is a prior provisionDevice() whose optimistic write
      // landed locally but whose commit never reached the server (Case A)
      // -- including the case where the app crashed before
      // reconcileAfterPostCommitFailure()'s inline rollback ever ran, so no
      // in-memory previousStateB64pd is left to roll back to.
      // provisionDevice()'s own local "already member" pre-check would
      // otherwise silently no-op forever (see AUDIT P1). Surfacing it
      // through the same epoch-conflict signal the 409 handlers already use
      // elsewhere in mls-membership.service.ts routes it through the
      // existing recovery machinery (backup restore first, escalating only
      // if that also fails), scoped to exactly the conversations this
      // mismatch was actually detected for -- not a blind catch-up sweep.
      if (await this.coordinator.isDeviceMemberLocally(conversationId, otherId, user, device)) {
        console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: local state believes', otherId, 'is already a member of', conversationId, 'but the server has no record of it -- signalling epoch conflict to trigger recovery');
        this.epochConflictBus.epochConflict$.next({ conversationId });
        continue;
      }

      try {
        await this.coordinator.provisionDevice(otherId, conversationId, user, device);
      } catch (err) {
        console.warn('[DeviceProvisioning] checkAndProvisionOnConnect: failed for device', otherId, 'conv', conversationId, ':', err);
      }
    }
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
