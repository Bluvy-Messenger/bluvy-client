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
import type { SessionDevice, StoredMlsState, PendingReprovisionRecord, PendingRemovalRecord } from './mls.types';

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
      // AUDIT P1 crash/restart: persist enough to survive a crash between
      // this write and postCommit() confirmation -- previousStateB64pd is
      // the confirmed state from immediately before this Remove+Add; the
      // MLS ratchet is one-way, so it can never be reconstructed from
      // newStateB64pd after the fact. Written in the SAME storage.update()
      // call as the Group State write itself, so IndexedDB's single-put
      // atomicity (see AUDIT_08) guarantees the two can never exist
      // independently of each other after a crash. See
      // recoverPendingReprovisions() and mls.types.ts's
      // PendingReprovisionRecord doc comment.
      const pendingReprovisions = state.pendingReprovisions ?? {};
      pendingReprovisions[conversationId] = {
        staleDeviceId,
        previousEpoch:    currentEpoch,
        previousStateB64: previousStateB64pd,
        newEpoch,
      };
      state.pendingReprovisions = pendingReprovisions;
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
      } else {
        // AUDIT P1-A: same reconciliation as provisionDevice() -- rollback
        // (CAS-guarded) to the pre-write state, then let
        // catchUpMissedCommits() ask the server directly whether the
        // Remove+Add commit actually landed. Empirically verified (see
        // mls-invariants-reprovision-divergence.spec.ts) that self-replaying
        // a Remove+Add commit via processPublicMessage produces a state
        // byte-identical to createCommit()'s own newState, exactly like the
        // pure-Add case -- and that the local optimistic write already
        // breaks the stale device's OLD (untouched) session's ability to
        // decrypt A's traffic even before any server round trip, so this
        // rollback additionally restores THAT interoperability, not just
        // administrative epoch agreement. Crash/restart detection for this
        // method remains explicitly out of scope (see that file's own
        // finding: isDeviceMemberLocally() cannot distinguish "correct
        // leaf" from "phantom-replaced leaf" here) -- a separate task.
        await this.reconcileAfterPostCommitFailure(conversationId, scope, newStateB64pd, previousStateB64pd, user, device, 'reprovisionLostStateDevice');
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
        // AUDIT P1 crash/restart: this device is no longer in-flight for
        // this conversation (either rolled back above, or about to adopt
        // the winning commit below) -- clear the marker in the same write.
        if (s.pendingReprovisions?.[conversationId]) delete s.pendingReprovisions[conversationId];
        s.updatedAt = Date.now();
        return s;
      });
      await this.commitSvc.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
      return;
    }

    // Confirmed: the crash/restart marker written above is no longer
    // needed -- an orphaned marker after a successful commit is harmless
    // regardless (recoverPendingReprovisions() re-validates newEpoch
    // against the CURRENT epoch before ever touching previousStateB64, see
    // Invariant 7), but there is no reason to leave it lying around.
    await this.storage.update<StoredMlsState>(scope, async (s) => {
      if (!s?.pendingReprovisions?.[conversationId]) return null;
      delete s.pendingReprovisions[conversationId];
      s.updatedAt = Date.now();
      return s;
    });

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
        // AUDIT P0 crash/restart: persist enough to survive a crash
        // between this write and postCommit() confirmation --
        // previousStateB64rrd is the confirmed state from immediately
        // before this Remove; the MLS ratchet is one-way, so it can never
        // be reconstructed from newStateB64rrd after the fact. Written in
        // the SAME storage.update() call as the Group State write itself
        // (no `await` in between), so IndexedDB's single-put atomicity
        // (see AUDIT_08) guarantees the two can never exist independently
        // of each other after a crash. See recoverPendingRemovals() and
        // mls.types.ts's PendingRemovalRecord doc comment.
        const pendingRemovals = current.pendingRemovals ?? {};
        pendingRemovals[convId] = {
          revokedDeviceId,
          previousEpoch:    currentEpoch,
          previousStateB64: previousStateB64rrd,
          newEpoch:         Number(newState.groupContext.epoch),
        };
        current.pendingRemovals = pendingRemovals;
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
        } else {
          // AUDIT GLOBAL P0: same reconciliation as provisionDevice() /
          // reprovisionLostStateDevice() -- a network failure here after
          // the optimistic Remove already wrote locally previously left
          // the revoked device believed-removed locally while the server
          // (and every other member) never applied anything, so the
          // "revoked" device's OLD session kept working -- empirically
          // confirmed (real ts-mls decrypt) it could still read traffic
          // from an unaware survivor. Roll back (CAS-guarded) and let
          // catchUpMissedCommits() (unmodified) determine whether the
          // Remove actually landed server-side, exactly as for the other
          // two membership-mutating methods.
          await this.reconcileAfterPostCommitFailure(convId, scope, newStateB64rrd, previousStateB64rrd, user, device, 'removeRevokedDeviceFromAllGroups');
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
          // AUDIT P0 crash/restart: this device is no longer in-flight for
          // this conversation (either rolled back above, or about to adopt
          // the winning commit below) -- clear the marker in the same write.
          if (s.pendingRemovals?.[convId]) delete s.pendingRemovals[convId];
          s.updatedAt = Date.now();
          return s;
        });
        void this.commitSvc.processIncomingCommit(convId, stored.commit, stored.epoch, user, device)
          .catch(err => console.warn('[MLS] removeRevokedDevice: resync after lost race failed for conv', convId, err));
        continue;
      }

      // Confirmed: the crash/restart marker written above is no longer
      // needed -- an orphaned marker after a successful commit is harmless
      // regardless (recoverOnePendingRemoval() re-validates newEpoch
      // against the CURRENT epoch before ever touching previousStateB64),
      // but there is no reason to leave it lying around.
      await this.storage.update<StoredMlsState>(scope, async (s) => {
        if (!s?.pendingRemovals?.[convId]) return null;
        delete s.pendingRemovals[convId];
        s.updatedAt = Date.now();
        return s;
      });
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
      // AUDIT P1 crash/restart: clear any reprovisionLostStateDevice()
      // marker for this conversation together with the rollback itself --
      // a harmless no-op for provisionDevice() callers, which never write
      // one. Safe to clear here (rather than only after
      // catchUpMissedCommits() below resolves) because once the rollback
      // above lands, local state is back to an ORDINARY "possibly behind
      // the server" epoch -- exactly the condition catchUpMissedCommits()
      // already handles correctly on every other normal reconnect/message
      // flow, marker or not. The marker's only job was making the correct
      // epoch queryable while local was still phantom-advanced; that job
      // is done the instant the rollback itself succeeds.
      if (s.pendingReprovisions?.[conversationId]) delete s.pendingReprovisions[conversationId];
      // AUDIT P0 crash/restart: same reasoning, applied to
      // removeRevokedDeviceFromAllGroups()'s marker -- harmless no-op for
      // provisionDevice()/reprovisionLostStateDevice() callers, which
      // never write one.
      if (s.pendingRemovals?.[conversationId]) delete s.pendingRemovals[conversationId];
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

  // AUDIT P1 crash/restart (reprovisionLostStateDevice() only, see the
  // design report -- deliberately NOT generalized to provisionDevice() in
  // this task): resolves any reprovisionLostStateDevice() operations left
  // in pendingReprovisions by a crash between the local optimistic write
  // and postCommit() confirmation, where reconcileAfterPostCommitFailure()
  // never got a chance to run and no in-memory previousStateB64pd survived.
  // Called from DeviceProvisioningService.checkAndProvisionOnConnect() on
  // reconnect -- iterates ONLY this map (normally empty, cheap), never a
  // blind sweep of every conversation.
  async recoverPendingReprovisions(
    user:   UserProfile,
    device: SessionDevice,
  ): Promise<void> {
    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    const pending = state?.pendingReprovisions;
    if (!pending) return;

    for (const conversationId of Object.keys(pending)) {
      await this.recoverOnePendingReprovision(conversationId, scope, user, device);
    }
  }

  private async recoverOnePendingReprovision(
    conversationId: string,
    scope:          string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    let rolledBack = false;

    // Single atomic storage.update() does both the re-validation and the
    // rollback-or-drop decision -- no separate pre-check/act pair, so
    // there is no TOCTOU gap between reading "is this marker still
    // current" and acting on it (matches every other CAS pattern in this
    // file).
    await this.storage.update<StoredMlsState>(scope, async (s) => {
      const marker: PendingReprovisionRecord | undefined = s?.pendingReprovisions?.[conversationId];
      if (!s || !marker) return null; // nothing pending, or already resolved (e.g. a concurrent call)

      const encoded = s.groupStates[conversationId];
      let currentEpoch: number | undefined;
      if (encoded) {
        try {
          currentEpoch = Number(this.cryptoCtx.restoreClientState(encoded).groupContext.epoch);
        } catch (err) {
          console.warn('[MLS] recoverPendingReprovisions: failed to decode current state for', conversationId, '-- dropping marker without acting on it', err);
        }
      }

      if (currentEpoch !== marker.newEpoch) {
        // The conversation has already moved past the phantom write this
        // marker describes (a real incoming commit, a different operation,
        // or a second reprovision that already resolved it) -- or the
        // state is missing/undecodable entirely. NEVER roll back over a
        // more recent state (Invariant 4/7): just drop the now-obsolete
        // marker without touching groupStates at all.
        console.log('[MLS:observability] recoverPendingReprovisions marker obsolete', {
          conversationId, deviceId: device.id, currentEpoch, markerNewEpoch: marker.newEpoch,
        });
        delete s.pendingReprovisions![conversationId];
        s.updatedAt = Date.now();
        return s;
      }

      console.log('[MLS:observability] recoverPendingReprovisions rolling back', {
        conversationId, deviceId: device.id, staleDeviceId: marker.staleDeviceId, previousEpoch: marker.previousEpoch, newEpoch: marker.newEpoch,
      });
      s.groupStates[conversationId] = marker.previousStateB64;
      delete s.pendingReprovisions![conversationId];
      s.updatedAt = Date.now();
      rolledBack = true;
      return s;
    });

    if (!rolledBack) return;

    // Same reasoning as reconcileAfterPostCommitFailure(): once the
    // rollback lands, local state is an ORDINARY "possibly behind the
    // server" epoch -- catchUpMissedCommits() (unmodified) now correctly
    // distinguishes Case A (0 commits, rollback stands) from Case B (our
    // own commit found, adopted via the normal incoming-commit path,
    // byte-identical to createCommit()'s own result -- already proven
    // empirically for this exact Remove+Add shape).
    try {
      const applied = await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
      console.log('[MLS:observability] recoverPendingReprovisions reconciled', { conversationId, deviceId: device.id, applied });
    } catch (err) {
      console.warn('[MLS] recoverPendingReprovisions: reconciliation attempt failed for conv', conversationId, '-- rollback still stands, an ordinary catch-up will pick it up later', err);
    }
  }

  // AUDIT P0 crash/restart (removeRevokedDeviceFromAllGroups() only):
  // resolves any Remove operations left in pendingRemovals by a crash
  // between the local optimistic write and postCommit() confirmation,
  // where reconcileAfterPostCommitFailure() never got a chance to run.
  // Called from DeviceProvisioningService.checkAndProvisionOnConnect() on
  // reconnect -- iterates ONLY this map (normally empty, cheap), never a
  // blind sweep of every conversation.
  async recoverPendingRemovals(
    user:   UserProfile,
    device: SessionDevice,
  ): Promise<void> {
    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    const pending = state?.pendingRemovals;
    if (!pending) return;

    for (const conversationId of Object.keys(pending)) {
      await this.recoverOnePendingRemoval(conversationId, scope, user, device);
    }
  }

  private async recoverOnePendingRemoval(
    conversationId: string,
    scope:          string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    let rolledBack = false;

    // Same single-atomic-storage.update() shape as recoverOnePendingReprovision()
    // for the same TOCTOU reason -- but this is NOT a mechanical copy: a
    // Remove has no Welcome, no re-added identity, and its failure mode is
    // a revocation that silently never took effect rather than a stalled
    // provisioning. The epoch-equality check below is deliberately treated
    // as a TRIGGER to re-verify with the server, never as proof by itself
    // -- confirmed empirically (AUDIT READ-ONLY crash/restart investigation,
    // Section 5 Case C) that currentEpoch === marker.newEpoch can be
    // produced by a completely unrelated real commit from another device
    // landing at the same target epoch number, not just by this marker's
    // own phantom write. Safety here comes entirely from the fact that the
    // rollback is ALWAYS followed by catchUpMissedCommits() -- an actual
    // server round trip -- never from trusting the epoch match as a
    // verdict on its own.
    await this.storage.update<StoredMlsState>(scope, async (s) => {
      const marker: PendingRemovalRecord | undefined = s?.pendingRemovals?.[conversationId];
      if (!s || !marker) return null; // nothing pending, or already resolved (e.g. a concurrent call)

      const encoded = s.groupStates[conversationId];
      let currentEpoch: number | undefined;
      if (encoded) {
        try {
          currentEpoch = Number(this.cryptoCtx.restoreClientState(encoded).groupContext.epoch);
        } catch (err) {
          console.warn('[MLS] recoverPendingRemovals: failed to decode current state for', conversationId, '-- dropping marker without acting on it', err);
        }
      }

      if (currentEpoch !== marker.newEpoch) {
        // The conversation has already moved past the phantom write this
        // marker describes (a real incoming commit, a different
        // operation, or a second Remove attempt that already resolved
        // it) -- or the state is missing/undecodable entirely. NEVER roll
        // back over a more recent state: just drop the now-obsolete
        // marker without touching groupStates at all.
        console.log('[MLS:observability] recoverPendingRemovals marker obsolete', {
          conversationId, deviceId: device.id, currentEpoch, markerNewEpoch: marker.newEpoch,
        });
        delete s.pendingRemovals![conversationId];
        s.updatedAt = Date.now();
        return s;
      }

      console.log('[MLS:observability] recoverPendingRemovals rolling back', {
        conversationId, deviceId: device.id, revokedDeviceId: marker.revokedDeviceId, previousEpoch: marker.previousEpoch, newEpoch: marker.newEpoch,
      });
      s.groupStates[conversationId] = marker.previousStateB64;
      delete s.pendingRemovals![conversationId];
      s.updatedAt = Date.now();
      rolledBack = true;
      return s;
    });

    if (!rolledBack) return;

    // Same reasoning as reconcileAfterPostCommitFailure(): once the
    // rollback lands, local state is an ORDINARY "possibly behind the
    // server" epoch -- catchUpMissedCommits() (unmodified) now correctly
    // distinguishes Case A (0 commits, rollback stands, the revoked
    // device keeps its access since it was never actually revoked) from
    // Case B (our own Remove commit found server-side, adopted via the
    // normal incoming-commit path -- the revoked device genuinely loses
    // access) or Case C (a DIFFERENT real commit from another device is
    // found and adopted instead, correctly, since it's what the server
    // round trip actually returns regardless of what this marker assumed).
    try {
      const applied = await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
      console.log('[MLS:observability] recoverPendingRemovals reconciled', { conversationId, deviceId: device.id, applied });
    } catch (err) {
      console.warn('[MLS] recoverPendingRemovals: reconciliation attempt failed for conv', conversationId, '-- rollback still stands, an ordinary catch-up will pick it up later', err);
    }
  }
}
