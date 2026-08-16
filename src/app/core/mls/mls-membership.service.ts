import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  createCommit,
  decodeMlsMessage,
  encodeGroupState,
  encodeMlsMessage,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { findLeafIndex } from 'ts-mls/ratchetTree.js';
import type { UserProfile } from '../auth/auth.types';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsRepository } from './mls.repository';
import { MlsCryptoContextService } from './mls-crypto-context.service';
import { MlsBackupRegistry } from './mls-backup-registry.service';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';
import { MlsCommitService } from './mls-commit.service';
import { MlsEpochConflictBus } from './mls-epoch-conflict-bus.service';
import { environment } from '../../../environments/environment';
import type { SessionDevice, StoredMlsState } from './mls.types';

// Membership mutations: adding a device (provisionDevice), re-adding a
// device that lost its local state (reprovisionLostStateDevice), fanning
// that out across an account's other devices (provisionAllOtherDevices),
// and removing a revoked device from every conversation
// (removeRevokedDeviceFromAllGroups). Extracted from MlsService (Phase 1
// Step 3 of the split).
//
// clearConversationGroup moves here too, alongside the plan's originally
// listed methods: it has no callers left in MlsService once these three
// 409-handler call sites move (grep-confirmed -- see the Step 3 commit
// message), and moving it here avoids a circular MlsService <-> this
// service dependency that keeping it on MlsService would otherwise force.
// MlsService.clearConversationGroup stays as a public delegate, same as
// every other method in this file, so nothing external (MlsCoordinatorService,
// its spec's mockMlsSvc) needs to change.
@Injectable({ providedIn: 'root' })
export class MlsMembershipService {
  private readonly mlsRepo            = inject(MlsRepository);
  private readonly storage            = inject(MlsStateStorageService);
  private readonly cryptoCtx          = inject(MlsCryptoContextService);
  private readonly backupRegistry     = inject(MlsBackupRegistry);
  private readonly pendingCommitTracker = inject(MlsPendingCommitTracker);
  private readonly commitSvc          = inject(MlsCommitService);
  private readonly epochConflictBus   = inject(MlsEpochConflictBus);

  // Provisions a single device into an existing MLS group.
  // Network: consume KP (before lock) → post Welcome + Commit (after lock).
  // Crypto + state write: inside the atomic update().
  async provisionDevice(
    newDeviceId:    string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    // Wait for any in-progress incoming commit to finish applying first, so we
    // never start building a proposal against an epoch that's about to be
    // superseded (mirrors encryptMessage/decryptMessage below) — narrows the
    // window for a wasted round trip + lost-race rollback.
    const pendingIncoming = this.pendingCommitTracker.get(conversationId);
    if (pendingIncoming) await pendingIncoming;

    const scope = this.cryptoCtx.makeScope(user.did, device.id);

    // Pre-check: abort early if there is nothing to provision (read-only, no lock).
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');
    if (!preState.groupStates[conversationId]) {
      if (!environment.production) console.log('[MLS] provisionDevice: no group state for', conversationId, '— skipping');
      return;
    }

    // Pre-check: skip immediately if already a member -- read-only, no network,
    // avoids wasting a KeyPackage consumption attempt on every reconnect for a
    // device that doesn't need (re-)provisioning at all (this is called for
    // every device x every conversation on each socket reconnect, see
    // DeviceProvisioningService.checkAndProvisionOnConnect). The check inside
    // the storage lock below stays as-is, as the TOCTOU safety net for two
    // concurrent provisionDevice calls racing each other.
    const preClientState = this.cryptoCtx.restoreClientState(preState.groupStates[conversationId]);
    if (this.cryptoCtx.isDeviceMember(preClientState, newDeviceId)) {
      if (!environment.production) console.log('[MLS] provisionDevice: device already member (pre-check), skipping', newDeviceId, conversationId);
      return;
    }

    // Acquire the reusable server-side commit lock before doing any work. If
    // another device already holds it (e.g. another of our devices reacting to
    // the same device:new event), skip cleanly instead of racing: whichever
    // device holds the lock accomplishes the same conversation-wide goal, and
    // we'll pick up its commit through the normal catch-up path. A network
    // failure asking for the lock is not treated as "denied" — proceed as
    // before, relying on the after-the-fact race detection below as a fallback.
    try {
      const { acquired } = await this.mlsRepo.acquireCommitLock(conversationId);
      if (!acquired) {
        if (!environment.production) console.log('[MLS] provisionDevice: commit lock held by another device for conv', conversationId, '— skipping');
        return;
      }
    } catch (err) {
      console.warn('[MLS] provisionDevice: failed to acquire commit lock for conv', conversationId, '— proceeding without it', err);
    }

    // Network: consume key package (before the storage lock).
    // The membership guard runs inside the lock (below) to prevent the TOCTOU race
    // where two concurrent provisionDevice calls both pass this pre-check and then
    // both create commits from the same epoch.
    let consumed: { keyPackage: string; deviceId: string };
    try {
      consumed = await this.mlsRepo.consumeOwnKeyPackage(newDeviceId);
    } catch (err) {
      const errCode = (err as { error?: { error?: { code?: string }; code?: string } })?.error?.error?.code || (err as { error?: { code?: string } })?.error?.code;
      if (err instanceof HttpErrorResponse && errCode === 'NO_KEY_PACKAGES') {
        console.warn('[MLS] provisionDevice: no key packages for', newDeviceId, '— cannot provision conv', conversationId);
      }
      throw err;
    }

    const decodedKP = decodeMlsMessage(this.cryptoCtx.base64ToBytes(consumed.keyPackage), 0)?.[0];
    if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') {
      throw new Error('Invalid key package received from server');
    }

    const cs = await this.cryptoCtx.getCiphersuiteImpl();

    const addProposal: ProposalAdd = {
      proposalType: 'add',
      add:          { keyPackage: decodedKP.keyPackage },
    };

    let currentEpoch: number;
    let shouldSkip = false;
    let welcomeB64 = '';
    let commitB64  = '';
    let newEpoch   = 0;
    let previousStateB64pd: string | undefined;
    let newStateB64pd      = '';

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) {
        // Group disappeared while we were fetching the key package.
        shouldSkip = true;
        return null;
      }

      const clientState = this.cryptoCtx.restoreClientState(encoded);
      currentEpoch = Number(clientState.groupContext.epoch);

      // Guard inside the lock: verify device is not already a member.
      // This prevents the TOCTOU race where two concurrent provisionDevice calls
      // both consumed a KP before entering this lock.
      if (this.cryptoCtx.isDeviceMember(clientState, newDeviceId)) {
        if (!environment.production) console.log('[MLS] provisionDevice: device already member (inside lock), skipping', newDeviceId, conversationId);
        shouldSkip = true;
        return null;
      }

      const { newState, welcome, commit } = await createCommit(
        { state: clientState, cipherSuite: cs },
        { extraProposals: [addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );

      if (!welcome) throw new Error('createCommit returned no welcome for device provisioning');

      welcomeB64 = this.cryptoCtx.bytesToBase64(encodeMlsMessage({
        version:    'mls10',
        wireformat: 'mls_welcome',
        welcome,
      }));
      commitB64       = this.cryptoCtx.bytesToBase64(encodeMlsMessage(commit));
      newEpoch        = Number(newState.groupContext.epoch);
      previousStateB64pd = state.groupStates[conversationId];
      newStateB64pd      = this.cryptoCtx.bytesToBase64(encodeGroupState(newState));

      state.groupStates[conversationId] = newStateB64pd;
      state.updatedAt = Date.now();
      return state;
    });

    if (shouldSkip) return;

    // Network: post Welcome and Commit atomically (after the storage lock).
    let stored;
    try {
      stored = await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch!, [{
        targetDeviceId: newDeviceId,
        welcome: welcomeB64,
      }]);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        console.warn('[MLS] provisionDevice: Epoch Conflict (409) detected. Clearing local state to force self-healing.', err);
        console.log('[MLS:observability] clearConversationGroup caller', { conversationId, caller: 'provisionDevice 409 handler' });
        await this.clearConversationGroup(conversationId, user, device);
        this.epochConflictBus.epochConflict$.next({ conversationId });
      } else {
        // AUDIT P1: any other postCommit() failure (timeout, connection
        // refused, 5xx, or the response simply never arriving) leaves the
        // question "did the server actually receive this commit?" open --
        // the optimistic write at L177 above already advanced local state
        // regardless. Reconcile instead of just throwing: roll back (CAS-
        // guarded, same pattern as the lost-race branch below) then let
        // catchUpMissedCommits() -- unmodified -- ask the server directly.
        // Case A (server never got it): 0 commits found, rollback stands.
        // Case B (server accepted it, only the response was lost):
        // catchUpMissedCommits() finds and applies our own commit via the
        // normal incoming-commit path -- empirically confirmed to produce a
        // ClientState byte-identical to createCommit()'s own newState (see
        // AUDIT P1 design report), so this is not a lossy re-derivation.
        await this.reconcileAfterPostCommitFailure(conversationId, scope, newStateB64pd, previousStateB64pd, user, device, 'provisionDevice');
      }
      throw err;
    }

    // The backend enforces UNIQUE(conversationId, epoch) and is idempotent on
    // conflict: if another device (e.g. another of our own devices reacting
    // to the same device:new event) posted a commit for this epoch first,
    // `stored` is THEIR commit, not ours, even though the request returned
    // 200. Applying our own optimistic local state in that case would fork
    // this device onto a group state nobody else recognizes. Detect it and
    // resync onto the winning commit instead of forking.
    if (stored.senderDeviceId !== device.id) {
      console.warn(
        '[MLS] provisionDevice: lost commit race for epoch', newEpoch, 'on conv', conversationId,
        '— rolling back optimistic state and applying the winning commit from', stored.senderDeviceId,
      );
      await this.storage.update<StoredMlsState>(scope, async (s) => {
        if (!s) return null;
        // Compare-and-swap: only roll back if our own optimistic write is
        // still the current value. If something else (e.g. a concurrent
        // incoming commit for this conversation) already moved the state
        // forward, leave it alone -- the processIncomingCommit() call below
        // reconciles correctly against whatever's actually there instead of
        // clobbering it with our stale previous snapshot (forensic audit
        // finding F10).
        if (s.groupStates[conversationId] !== newStateB64pd) {
          console.log('[MLS:observability] provisionDevice lost-race rollback skipped (concurrent write detected)', { conversationId, deviceId: device.id });
          return null;
        }
        if (previousStateB64pd === undefined) delete s.groupStates[conversationId];
        else s.groupStates[conversationId] = previousStateB64pd;
        s.updatedAt = Date.now();
        return s;
      });
      await this.commitSvc.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
      return;
    }

    if (newStateB64pd !== previousStateB64pd) {
      this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64pd);
    }
    if (!environment.production) console.log('[MLS] provisionDevice: provisioned', newDeviceId, 'for', conversationId, 'epoch', newEpoch);
  }

  // Re-provisions a device that already has a leaf in the MLS tree but lost
  // its local state (see Phase 8b / AUDIT_02 Root Cause #3): claimInitiatorSlot
  // nudges another of the account's devices via device:new{reason:'lost_state'}
  // instead of letting the stale device unilaterally reset the group.
  // provisionDevice() can't help here — its "already a member" guard always
  // fires for this device, since it was never removed from the tree, and MLS
  // has no operation to "resend a Welcome" to an existing leaf. This removes
  // the stale leaf and re-adds it in the same commit, producing a fresh
  // Welcome in one epoch bump.
  async reprovisionLostStateDevice(
    staleDeviceId:  string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    // Same rationale as provisionDevice(): don't race a proposal against an
    // epoch that's about to be superseded by an in-flight incoming commit.
    const pendingIncoming = this.pendingCommitTracker.get(conversationId);
    if (pendingIncoming) await pendingIncoming;

    const scope = this.cryptoCtx.makeScope(user.did, device.id);

    // Pre-check: abort early if there is nothing to fix (read-only, no lock).
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');
    if (!preState.groupStates[conversationId]) {
      if (!environment.production) console.log('[MLS] reprovisionLostStateDevice: no group state for', conversationId, '— skipping');
      return;
    }

    // Same reusable server-side commit lock as provisionDevice(): if another
    // of our own devices is already reacting to the same nudge, skip
    // cleanly — whichever one succeeds accomplishes the same goal.
    try {
      const { acquired } = await this.mlsRepo.acquireCommitLock(conversationId);
      if (!acquired) {
        if (!environment.production) console.log('[MLS] reprovisionLostStateDevice: commit lock held by another device for conv', conversationId, '— skipping');
        return;
      }
    } catch (err) {
      console.warn('[MLS] reprovisionLostStateDevice: failed to acquire commit lock for conv', conversationId, '— proceeding without it', err);
    }

    // Network: consume a fresh key package for the stale device (before the
    // storage lock) so its re-added leaf gets new key material, not the
    // (possibly compromised or simply stale) key material it originally
    // joined with.
    let consumed: { keyPackage: string; deviceId: string };
    try {
      consumed = await this.mlsRepo.consumeOwnKeyPackage(staleDeviceId);
    } catch (err) {
      const errCode = (err as { error?: { error?: { code?: string }; code?: string } })?.error?.error?.code || (err as { error?: { code?: string } })?.error?.code;
      if (err instanceof HttpErrorResponse && errCode === 'NO_KEY_PACKAGES') {
        console.warn('[MLS] reprovisionLostStateDevice: no key packages for', staleDeviceId, '— cannot reprovision conv', conversationId);
      }
      throw err;
    }

    const decodedKP = decodeMlsMessage(this.cryptoCtx.base64ToBytes(consumed.keyPackage), 0)?.[0];
    if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') {
      throw new Error('Invalid key package received from server');
    }

    const cs = await this.cryptoCtx.getCiphersuiteImpl();

    const addProposal: ProposalAdd = {
      proposalType: 'add',
      add:          { keyPackage: decodedKP.keyPackage },
    };

    let currentEpoch: number;
    let shouldSkip = false;
    let welcomeB64 = '';
    let commitB64  = '';
    let newEpoch   = 0;
    let previousStateB64pd: string | undefined;
    let newStateB64pd      = '';

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) {
        // Group disappeared while we were fetching the key package.
        shouldSkip = true;
        return null;
      }

      const clientState = this.cryptoCtx.restoreClientState(encoded);
      currentEpoch = Number(clientState.groupContext.epoch);

      // Find the stale device's current leaf. If it's no longer a member,
      // another device already fixed it (or it was never a member to begin
      // with) — skip idempotently rather than attempt a Remove for a leaf
      // that doesn't exist.
      //
      // Same bug/fix as removeRevokedDeviceFromAllGroups(): getGroupMembers()
      // (ts-mls/clientState.js) filters state.ratchetTree down to non-blank
      // leaves only, so its array position is NOT the MLS leaf index once
      // any earlier leaf has been blanked by a prior Remove. Using that
      // position directly as `remove.removed` can silently target a
      // DIFFERENT, still-occupied leaf — validateRemove() only rejects a
      // blank target, it never checks that the index actually corresponds
      // to the intended identity, so a wrong-but-occupied index removes an
      // unrelated device instead of throwing. findLeafIndex() (ts-mls's own
      // API, ts-mls/ratchetTree.js) resolves the true leaf index directly
      // from the raw tree by matching the LeafNode itself.
      const members = getGroupMembers(clientState);
      const dec = new TextDecoder();
      const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
        m.credential.credentialType === 'basic' &&
        dec.decode(m.credential.identity).endsWith(`#${staleDeviceId}`)
      );

      if (!targetMember) {
        if (!environment.production) console.log('[MLS] reprovisionLostStateDevice: device not (or no longer) a member, nothing to fix', staleDeviceId, conversationId);
        shouldSkip = true;
        return null;
      }

      const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember);

      if (leafIndex === undefined) {
        if (!environment.production) console.log('[MLS] reprovisionLostStateDevice: device not (or no longer) a member, nothing to fix', staleDeviceId, conversationId);
        shouldSkip = true;
        return null;
      }

      console.log('[MLS:observability] reprovisionLostStateDevice', {
        conversationId, staleDeviceId, removedLeafIndex: leafIndex, actingDeviceId: device.id, currentEpoch,
      });

      // Remove the stale leaf and re-add the same identity fresh in a single
      // commit. Order of extraProposals doesn't matter: ts-mls groups
      // proposal application by type (update -> remove -> add) regardless of
      // array order, and explicitly permits an Add for an identity already
      // in the group when a matching Remove is in the same commit.
      const removeProposal = {
        proposalType: 'remove' as const,
        remove:       { removed: leafIndex },
      };

      const { newState, welcome, commit } = await createCommit(
        { state: clientState, cipherSuite: cs },
        { extraProposals: [removeProposal, addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );

      if (!welcome) throw new Error('createCommit returned no welcome for lost-state re-provisioning');

      welcomeB64 = this.cryptoCtx.bytesToBase64(encodeMlsMessage({
        version:    'mls10',
        wireformat: 'mls_welcome',
        welcome,
      }));
      commitB64       = this.cryptoCtx.bytesToBase64(encodeMlsMessage(commit));
      newEpoch        = Number(newState.groupContext.epoch);
      previousStateB64pd = state.groupStates[conversationId];
      newStateB64pd      = this.cryptoCtx.bytesToBase64(encodeGroupState(newState));

      state.groupStates[conversationId] = newStateB64pd;
      state.updatedAt = Date.now();
      return state;
    });

    if (shouldSkip) return;

    // Network: post Welcome and Commit atomically (after the storage lock).
    let stored;
    try {
      stored = await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch!, [{
        targetDeviceId: staleDeviceId,
        welcome: welcomeB64,
      }]);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        console.warn('[MLS] reprovisionLostStateDevice: Epoch Conflict (409) detected. Clearing local state to force self-healing.', err);
        console.log('[MLS:observability] clearConversationGroup caller', { conversationId, caller: 'reprovisionLostStateDevice 409 handler' });
        await this.clearConversationGroup(conversationId, user, device);
        this.epochConflictBus.epochConflict$.next({ conversationId });
      }
      throw err;
    }

    // Same lost-commit-race handling as provisionDevice(): if another of our
    // own devices (reacting to the same nudge) posted a commit for this
    // epoch first, resync onto its commit instead of forking.
    if (stored.senderDeviceId !== device.id) {
      console.warn(
        '[MLS] reprovisionLostStateDevice: lost commit race for epoch', newEpoch, 'on conv', conversationId,
        '— rolling back optimistic state and applying the winning commit from', stored.senderDeviceId,
      );
      await this.storage.update<StoredMlsState>(scope, async (s) => {
        if (!s) return null;
        // Compare-and-swap: only roll back if our own optimistic write is
        // still the current value -- see provisionDevice's identical rollback
        // for the full rationale (forensic audit finding F10).
        if (s.groupStates[conversationId] !== newStateB64pd) {
          console.log('[MLS:observability] reprovisionLostStateDevice lost-race rollback skipped (concurrent write detected)', { conversationId, deviceId: device.id });
          return null;
        }
        if (previousStateB64pd === undefined) delete s.groupStates[conversationId];
        else s.groupStates[conversationId] = previousStateB64pd;
        s.updatedAt = Date.now();
        return s;
      });
      await this.commitSvc.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
      return;
    }

    if (newStateB64pd !== previousStateB64pd) {
      this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64pd);
    }
    if (!environment.production) console.log('[MLS] reprovisionLostStateDevice: reprovisioned', staleDeviceId, 'for', conversationId, 'epoch', newEpoch);
  }

  // Provisions all other own devices into an existing MLS group.
  async provisionAllOtherDevices(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    let otherDevices: Array<{ id: string; name: string; platform: string }>;
    try {
      const resp = await this.mlsRepo.getMyDevices();
      otherDevices = resp.data.filter(d => d.id !== device.id);
    } catch (err) {
      console.warn('[MLS] provisionAllOtherDevices: failed to get device list', err);
      return;
    }

    for (const otherDevice of otherDevices) {
      try {
        await this.provisionDevice(otherDevice.id, conversationId, user, device);
      } catch (err) {
        console.warn('[MLS] provisionAllOtherDevices: failed to provision', otherDevice.id, 'for', conversationId, ':', err);
      }
    }
  }

  // Clears the MLS group state for a single conversation.
  async clearConversationGroup(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    console.log('[MLS:observability] clearConversationGroup', { conversationId, deviceId: device.id, caller: 'mlsService.clearConversationGroup' });
    const scope = this.cryptoCtx.makeScope(user.did, device.id);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;

      // Record a tombstone of the highest epoch this device is known to
      // have reached, before deleting the only local record of it. Without
      // this, a later automatic backup-restore (SyncService.onGroupNotReady)
      // has nothing to compare against and can silently resurrect a stale
      // snapshot -- see injectRestoredGroupStates()'s anti-regression check.
      const encoded = state.groupStates[conversationId];
      if (encoded) {
        try {
          const epoch = Number(this.cryptoCtx.restoreClientState(encoded).groupContext.epoch);
          const epochs = state.lastKnownEpochs ?? {};
          epochs[conversationId] = Math.max(epochs[conversationId] ?? -1, epoch);
          state.lastKnownEpochs = epochs;
        } catch (err) {
          // A corrupt/undecodable group state must not block the clear.
          console.warn('[MLS] clearConversationGroup: failed to record epoch tombstone for', conversationId, ':', err);
        }
      }

      delete state.groupStates[conversationId];
      state.updatedAt = Date.now();
      return state;
    });
  }

  async removeRevokedDeviceFromAllGroups(
    revokedDeviceId: string,
    user:            UserProfile,
    device:          SessionDevice,
  ): Promise<void> {
    const scope = this.cryptoCtx.getStorageScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    if (!state || !state.groupStates) return;

    for (const convId of Object.keys(state.groupStates)) {
      // Wait for any in-progress incoming commit for THIS conversation to
      // finish applying first (mirrors provisionDevice() / encryptMessage() /
      // decryptMessage()) — narrows the window for a wasted round trip +
      // lost-race rollback below.
      const pendingIncoming = this.pendingCommitTracker.get(convId);
      if (pendingIncoming) await pendingIncoming;

      // Acquire the reusable commit lock before doing any work for this
      // conversation — same rationale as provisionDevice(): if another device
      // (e.g. another member notified by the same device:revoked event)
      // already holds it, skip cleanly instead of racing to remove the same
      // leaf twice. A network failure asking for the lock is not treated as
      // "denied" — proceed, relying on the after-the-fact race detection below.
      try {
        const { acquired } = await this.mlsRepo.acquireCommitLock(convId);
        if (!acquired) {
          if (!environment.production) console.log('[MLS] removeRevokedDevice: commit lock held by another device for conv', convId, '— skipping');
          continue;
        }
      } catch (err) {
        if (err instanceof HttpErrorResponse && (err.status === 403 || err.status === 404)) {
          if (!environment.production) console.warn('[MLS] removeRevokedDevice: conversation not found or access forbidden, clearing state for conv', convId);
          await this.storage.update<StoredMlsState>(scope, async (current) => {
            if (current && current.groupStates) {
              delete current.groupStates[convId];
              if (current.conversations) delete current.conversations[convId];
              current.updatedAt = Date.now();
              return current;
            }
            return null;
          });
          continue;
        }
        console.warn('[MLS] removeRevokedDevice: failed to acquire commit lock for conv', convId, '— proceeding without it', err);
      }

      // Build the Remove commit inside the storage lock, but perform no
      // network I/O here (see mls-state-storage.service.ts's updater
      // contract: "Network calls ... MUST NOT appear inside the updater").
      // postCommit() and the 409 handler's clearConversationGroup() run
      // after the lock has released, below, mirroring provisionDevice()'s
      // shape -- doing them inside this same-scope updater used
      // to deadlock, since clearConversationGroup() itself calls
      // storage.update() on the same scope while the outer updater was
      // still awaiting it (see forensic audit finding F1).
      let shouldSkip            = false;
      let currentEpoch:         number | undefined;
      let commitB64             = '';
      let previousStateB64rrd:  string | undefined;
      let newStateB64rrd        = '';

      await this.storage.update<StoredMlsState>(scope, async (current) => {
        if (!current || !current.groupStates || !current.groupStates[convId]) {
          shouldSkip = true;
          return null;
        }

        const encoded = current.groupStates[convId];
        const clientState = this.cryptoCtx.restoreClientState(encoded);
        currentEpoch = Number(clientState.groupContext.epoch);
        const members = getGroupMembers(clientState);
        const dec = new TextDecoder();

        // getGroupMembers() (ts-mls/clientState.js) filters state.ratchetTree
        // down to non-blank leaves only, in raw tree order -- so its array
        // position is NOT the MLS leaf index once any earlier leaf has been
        // blanked by a prior Remove (each blank leaf shifts every later
        // member's compacted position down by one relative to their real
        // leaf index). Using that position as `remove.removed` then points
        // ts-mls at the wrong (possibly already-blank) leaf, which
        // validateRemove() rejects with "Tried to remove empty leaf node"
        // (ts-mls/dist/src/clientState.js). findLeafIndex() (ts-mls's own
        // API, ts-mls/ratchetTree.js) resolves the true leaf index directly
        // from the raw tree by matching the LeafNode itself, independent of
        // how many earlier leaves are blank.
        const targetMember = members.find((m) =>
          m.credential.credentialType === 'basic' &&
          dec.decode(m.credential.identity).endsWith(`#${revokedDeviceId}`)
        );

        if (!targetMember) {
          shouldSkip = true;
          return null;
        }

        const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember);

        if (leafIndex === undefined) {
          shouldSkip = true;
          return null;
        }

        if (!environment.production) console.warn('[MLS] removeRevokedDevice: found device to remove in conv', convId, revokedDeviceId, 'at leaf', leafIndex);

        const cs = await this.cryptoCtx.getCiphersuiteImpl();
        const removeProposal = {
          proposalType: 'remove' as const,
          remove: { removed: leafIndex },
        };

        const { newState, commit } = await createCommit(
          { state: clientState, cipherSuite: cs },
          { extraProposals: [removeProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
        );

        commitB64            = this.cryptoCtx.bytesToBase64(encodeMlsMessage(commit));
        previousStateB64rrd  = current.groupStates[convId];
        newStateB64rrd       = this.cryptoCtx.bytesToBase64(encodeGroupState(newState));

        current.groupStates[convId] = newStateB64rrd;
        current.updatedAt = Date.now();
        return current;
      });

      if (shouldSkip) continue;

      // Network: post the Remove commit (after the storage lock has released).
      let stored;
      try {
        stored = await this.mlsRepo.postCommit(convId, commitB64, currentEpoch!);
      } catch (err) {
        if (err instanceof HttpErrorResponse && err.status === 409) {
          console.warn('[MLS] removeRevokedDevice: Epoch Conflict (409) detected. Clearing local state to force self-healing.', err);
          console.log('[MLS:observability] clearConversationGroup caller', { conversationId: convId, caller: 'removeRevokedDeviceFromAllGroups 409 handler' });
          await this.clearConversationGroup(convId, user, device);
          this.epochConflictBus.epochConflict$.next({ conversationId: convId });
        }
        console.error('[MLS] removeRevokedDevice: failed to post Remove commit for conv', convId, err);
        continue;
      }

      // Another device may have posted a commit for the same epoch first (e.g.
      // another recipient of the same device:revoked event racing to remove the
      // same device). Detect it the same way provisionDevice() does: if the
      // stored commit isn't ours, roll back our optimistic state and resync onto
      // the winning commit instead, so we don't fork.
      if (stored.senderDeviceId !== device.id) {
        console.warn(
          '[MLS] removeRevokedDevice: lost commit race for conv', convId,
          '— resyncing on winning commit from', stored.senderDeviceId,
        );
        await this.storage.update<StoredMlsState>(scope, async (s) => {
          if (!s) return null;
          // Compare-and-swap: only roll back if our own optimistic write is
          // still the current value -- see provisionDevice's identical
          // rollback for the full rationale (forensic audit finding F10).
          if (s.groupStates[convId] !== newStateB64rrd) {
            console.log('[MLS:observability] removeRevokedDevice lost-race rollback skipped (concurrent write detected)', { conversationId: convId, deviceId: device.id });
            return null;
          }
          if (previousStateB64rrd === undefined) delete s.groupStates[convId];
          else s.groupStates[convId] = previousStateB64rrd;
          s.updatedAt = Date.now();
          return s;
        });
        void this.commitSvc.processIncomingCommit(convId, stored.commit, stored.epoch, user, device)
          .catch(err => console.warn('[MLS] removeRevokedDevice: resync after lost race failed for conv', convId, err));
      }
    }
  }

  // AUDIT P1 (provisionDevice client/server divergence after network
  // failure): after a postCommit() failure that is NOT a confirmed 409, the
  // optimistic local write from storage.update() may or may not have
  // actually reached the server. Roll back to the pre-write state -- CAS-
  // guarded exactly like the lost-commit-race branches above, so a
  // concurrent write in the meantime is never clobbered -- then let
  // catchUpMissedCommits() (unmodified) determine from the server itself
  // whether our commit actually landed:
  //   Case A (server never received it): 0 commits found, rollback stands.
  //   Case B (server accepted it, only the response was lost):
  //     catchUpMissedCommits() finds our own commit (stored server-side
  //     under the pre-write epoch, per the "epoch = built from" schema
  //     convention) and applies it via the normal incoming-commit path.
  // If the CAS check fails (some other operation already moved the state
  // forward -- a concurrent incoming commit, or another optimistic write),
  // nothing is forced: the rollback is skipped entirely, mirroring the
  // "return null" skip already used by every lost-race branch in this file.
  private async reconcileAfterPostCommitFailure(
    conversationId:     string,
    scope:              string,
    optimisticStateB64: string,
    previousStateB64:   string | undefined,
    user:               UserProfile,
    device:             SessionDevice,
    caller:             string,
  ): Promise<void> {
    let rolledBack = false;

    await this.storage.update<StoredMlsState>(scope, async (s) => {
      if (!s) return null;
      if (s.groupStates[conversationId] !== optimisticStateB64) {
        console.log('[MLS:observability] reconcileAfterPostCommitFailure rollback skipped (concurrent write detected)', { conversationId, deviceId: device.id, caller });
        return null;
      }
      if (previousStateB64 === undefined) delete s.groupStates[conversationId];
      else s.groupStates[conversationId] = previousStateB64;
      s.updatedAt = Date.now();
      rolledBack = true;
      return s;
    });

    if (!rolledBack) return;

    console.log('[MLS:observability] reconcileAfterPostCommitFailure rolled back, reconciling with server', { conversationId, deviceId: device.id, caller });

    try {
      const applied = await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
      console.log('[MLS:observability] reconcileAfterPostCommitFailure reconciled', { conversationId, deviceId: device.id, caller, applied });
    } catch (reconcileErr) {
      // The reconciliation attempt itself failed (e.g. a second network
      // failure). The rollback still stands -- local state correctly
      // reflects the last confirmed epoch rather than a phantom-advanced
      // one -- so this is safe to leave for the next reconnect sweep
      // (DeviceProvisioningService.checkAndProvisionOnConnect) instead of
      // retrying inline here.
      console.warn('[MLS] reconcileAfterPostCommitFailure: reconciliation attempt failed for conv', conversationId, '-- rollback still stands, will be retried on next reconnect', reconcileErr);
    }
  }

  // Read-only, no lock, no network -- mirrors provisionDevice()'s own local
  // "already member" pre-check (L74-85 above). Exposed separately for
  // DeviceProvisioningService's reconnect sweep: cross-referencing this
  // against the server's own getPendingProvisions() list is how the sweep
  // detects a conversation whose local state phantom-advanced past a
  // Commit the server never actually received (AUDIT P1), for the case
  // where the app crashed before reconcileAfterPostCommitFailure() ever ran
  // and no in-memory previousStateB64pd is left to roll back to.
  async isDeviceMemberLocally(
    conversationId: string,
    deviceId:       string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<boolean> {
    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    const encoded = state?.groupStates[conversationId];
    if (!encoded) return false;
    const clientState = this.cryptoCtx.restoreClientState(encoded);
    return this.cryptoCtx.isDeviceMember(clientState, deviceId);
  }
}
