import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultAuthenticationService,
  defaultCapabilities,
  defaultCryptoProvider,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  encodeMlsMessage,
  encodeGroupState,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  type ClientConfig,
  type ClientState,
  type Credential,
  type KeyPackage,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import type { UserProfile } from '../auth/auth.types';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsRepository } from './mls.repository';
import { MlsCryptoContextService } from './mls-crypto-context.service';
import { MlsBackupRegistry } from './mls-backup-registry.service';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';
import type {
  SerializedPrivateKeyPackage,
  StoredKeyPackageRecord,
  PreparedConversationState,
  StoredMlsState,
  SessionDevice,
  WelcomeProcessingResult,
} from './mls.types';
import { MlsWelcomeService } from './mls-welcome.service';
import { MlsCommitService } from './mls-commit.service';
import { MlsEpochConflictBus } from './mls-epoch-conflict-bus.service';
import { MlsMembershipService } from './mls-membership.service';
import { MlsMessageCryptoService } from './mls-message-crypto.service';

export type { UploadedKeyPackage } from './mls.types';

export type {
  SerializedPrivateKeyPackage,
  StoredKeyPackageRecord,
  PreparedConversationState,
  StoredMlsState,
  SessionDevice,
  WelcomeProcessingResult,
} from './mls.types';

export interface PreparedConversationInitialization {
  participantDid:    string;
  initiatorDeviceId: string;
  keyPackages: Array<{
    id:         string;
    deviceId:   string;
    keyPackage: KeyPackage;
  }>;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class MlsService {
  private readonly mlsRepo            = inject(MlsRepository);
  private readonly storage            = inject(MlsStateStorageService);
  private readonly cryptoCtx          = inject(MlsCryptoContextService);
  private readonly backupRegistry     = inject(MlsBackupRegistry);
  private readonly pendingCommitTracker = inject(MlsPendingCommitTracker);
  private readonly welcomeSvc         = inject(MlsWelcomeService);
  private readonly commitSvc          = inject(MlsCommitService);
  private readonly epochConflictBus   = inject(MlsEpochConflictBus);
  private readonly membershipSvc      = inject(MlsMembershipService);
  private readonly messageCryptoSvc   = inject(MlsMessageCryptoService);

  // Thin delegate, kept so the many call sites below don't all need touching
  // in this same step -- MlsCryptoContextService (mls-crypto-context.service.ts)
  // is the real owner now. Call sites migrate to `this.cryptoCtx.X` directly
  // as each method physically moves to its own sub-service in later steps.
  private get cipherSuiteName(): typeof this.cryptoCtx.cipherSuiteName {
    return this.cryptoCtx.cipherSuiteName;
  }

  // Thin delegate to MlsEpochConflictBus (mls-epoch-conflict-bus.service.ts) --
  // MlsCoordinatorService subscribes to this property directly, so it must
  // stay on MlsService even though MlsMembershipService is the one that now
  // detects and emits 409 conflicts.
  get epochConflict$(): typeof this.epochConflictBus.epochConflict$ {
    return this.epochConflictBus.epochConflict$;
  }

  // ── Session initialization ─────────────────────────────────────────────────

  async initializeForSession(user: UserProfile, device: SessionDevice): Promise<void> {
    const scope = this.makeScope(user.did, device.id);

    // Keyed by conversationId only (see MlsCoordinatorService.initializeForSession
    // for the full account-switch rationale). AuthService.switchAccount() always
    // disconnects the socket before this runs and doesn't reconnect until after
    // it resolves, so no commit processing can genuinely be in flight here --
    // safe to drop unconditionally rather than track the previous scope.
    this.pendingCommitTracker.clear();

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state || state.userDid !== user.did || state.deviceId !== device.id) {
        return {
          version:            1,
          userDid:            user.did,
          deviceId:           device.id,
          deviceName:         device.name,
          platform:           device.platform,
          cipherSuiteName:    this.cipherSuiteName,
          credentialIdentity: this.buildCredentialIdentity(user.did, device.id),
          keyPackages:        [],
          conversations:      {},
          groupStates:        {},
          initializedAt:      Date.now(),
          updatedAt:          Date.now(),
        };
      }
      state.deviceName = device.name;
      state.platform   = device.platform;
      if (!state.groupStates) state.groupStates = {};
      state.updatedAt = Date.now();
      return state;
    });
  }

  // ── MLS Group operations ───────────────────────────────────────────────────

  // Ensures an MLS group exists for the given conversation.
  // All expensive operations (network, HPKE crypto) happen outside the storage
  // lock. The final state write is atomic via storage.update().
  // AUDIT P0 crash/restart (genesis): decomposed into two phases per the
  // design report (Option 1). Phase 1 (createGroup() -> persist the SOLO
  // ClientState, creator alone) runs entirely locally, before any network
  // call at all -- unconditionally safe, no marker needed, since nothing
  // has been confirmed or even attempted server-side yet. Phase 2 (add the
  // first participants) mirrors provisionDevice()'s already-proven shape:
  // optimistic write + PendingGenesisRecord marker in the SAME
  // storage.update(), postCommit(), rollback-CAS + catchUpMissedCommits()
  // on non-409 failure, clearConversationGroup()+epochConflictBus on 409 --
  // exactly the pattern already validated for provisionDevice(),
  // reprovisionLostStateDevice(), and removeRevokedDeviceFromAllGroups().
  //
  // A solo state (encodeGroupState()/decodeGroupState() already carries the
  // FULL ClientState including privatePath and signaturePrivateKey -- see
  // ts-mls's GroupState type -- so no separate secret-carrying field is
  // needed beyond the same groupStates[conversationId] string every other
  // method already uses) is recognized on restart purely by its member
  // count (<=1) -- no new persisted flag for Phase 1, per the design
  // report's "Machine à états" analysis: PERSISTED is fully derivable.
  async ensureGroupReady(
    conversationId: string,
    participantDid: string,
    user:           UserProfile,
    device:         SessionDevice,
    signal?:        AbortSignal,
    preConsumedKeyPackage?: { keyPackage: string; deviceId: string },
    memberDids?:    string[],
  ): Promise<void> {
    const scope = this.makeScope(user.did, device.id);

    // Quick pre-check (read-only, no lock).
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');

    let soloStateB64: string | undefined;

    if (preState.groupStates[conversationId]) {
      if (preState.pendingGenesises?.[conversationId]) {
        // AUDIT ADVERSARIAL P1 (section 5, PendingGenesis): a crash can
        // leave this conversation's Phase 2 write persisted locally (already
        // showing >1 members) while the server never received anything at
        // all. A GroupState existing locally -- even with >1 members -- is
        // NEVER treated as proof of confirmation while its marker is still
        // present; confirmed empirically by a direct ensureGroupReady()
        // retry (bypassing recoverPendingGenesises()) after such a crash,
        // which previously returned success with zero real server-side
        // commits. Resolve it via the exact same rollback-CAS +
        // catchUpMissedCommits() recovery recoverPendingGenesises() already
        // uses -- deduped against a concurrent recoverPendingGenesises()
        // sweep for the same conversationId, so this always awaits the
        // FULL reconciliation (never observes a mid-flight rollback from a
        // sibling call that already won the CAS) -- then re-derive from the
        // ACTUAL post-recovery state below, never from this pre-recovery
        // snapshot.
        await this.recoverOnePendingGenesisDeduped(conversationId, scope, user, device);
        const postRecovery = await this.storage.load<StoredMlsState>(scope);
        if (!postRecovery?.groupStates[conversationId]) throw new Error('MLS not initialized');
        preState.groupStates[conversationId] = postRecovery.groupStates[conversationId];
      }

      const existingClientState = this.restoreClientState(preState.groupStates[conversationId]);
      if (getGroupMembers(existingClientState).length > 1) {
        // Genuinely confirmed (no marker was pending, or recovery just
        // confirmed the marker's commit really did land) -- existing
        // behavior unchanged. In case we missed the Socket.IO welcome event
        // while offline or disconnected, check if there is a pending
        // Welcome for us on the server. If there is, it means the group was
        // reset by another device, so our local state is obsolete.
        let welcomeResult: WelcomeProcessingResult = 'none';
        try {
          welcomeResult = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
          if (welcomeResult === 'joined' && !environment.production) {
            console.log('[MLS] ensureGroupReady: successfully healed group from welcome on page load', conversationId);
          }
        } catch (err) {
          console.warn('[MLS] ensureGroupReady: background welcome check failed', err);
        }

        // AUDIT P2 fix: an already-confirmed member (already a real leaf in
        // the tree, no reset happened) can simply have missed later commits
        // while offline/disconnected -- the real-time mls:commit socket
        // push is the normal catch-up mechanism, but a device that was
        // disconnected when those commits landed never received them, and
        // nothing else in this branch brought it forward. Without this, a
        // successful ensureGroupReady() could return on a stale epoch, and
        // a subsequent encryptMessage() would produce a message any member
        // who joined during the outage could never decrypt (confirmed
        // empirically with real ts-mls crypto: PermanentMlsError
        // 'EpochTooOld'). Skipped only when a fresh Welcome was ACTUALLY
        // JOINED above ('joined' -- joining via Welcome always delivers the
        // current epoch directly, so catching up against the brand new
        // state would be redundant, and if the group was actually reset,
        // the pre-reset commit history is no longer relevant). AUDIT P1 fix
        // (Welcome-obsolete-return-value): 'obsolete' and 'already-processed'
        // are NOT joins -- a correctly-rejected stale Welcome or an
        // idempotent re-delivery must still fall through to catch-up here,
        // proven empirically to otherwise leave this device stuck on a
        // stale epoch after a "successful" ensureGroupReady() call.
        // Deliberately NOT wrapped in a swallowed try/catch like the
        // Welcome check above: this is the actual guarantee
        // ensureGroupReady() is meant to provide, so a genuine failure here
        // must propagate rather than silently returning "ready" on a state
        // just found to be potentially stale.
        if (welcomeResult !== 'joined') {
          await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
        }
        return;
      }
      // Solo preparatory state (Phase 1 only, from this attempt or a prior
      // crashed one) -- skip the role/join negotiation entirely (we
      // already know locally that we are the initiator; no server round
      // trip needed to re-derive an identity the backend itself can no
      // longer confirm once mlsInitializedAt is set, see the design
      // report §5) and go straight to Phase 2 below, reusing this exact
      // persisted solo state instead of calling createGroup() again.
      soloStateB64 = preState.groupStates[conversationId];
    } else {
      // No local state at all -- the backend is the single authority on
      // who creates the MLS group.
      const { role } = await this.mlsRepo.ensureGroup(conversationId);

      if (role !== 'initiator') {
        const POLLS_PER_ROUND = 3;
        const POLL_DELAY_MS   = 2000;
        let currentRole: 'initiator' | 'joiner' | 'already_initialized' = role;
        let round = 0;

        while (true) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          for (let attempt = 0; attempt < POLLS_PER_ROUND; attempt++) {
            if (attempt > 0) {
              await new Promise<void>(resolve => setTimeout(resolve, POLL_DELAY_MS));
            }

            // Read-only check between polls.
            const s = await this.storage.load<StoredMlsState>(scope);
            if (!s) throw new Error('MLS not initialized');
            if (s.groupStates[conversationId]) return;

            let welcomeResult: WelcomeProcessingResult = 'none';
            try {
              welcomeResult = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
            } catch (err) {
              console.warn('[MLS] ensureGroupReady: fetchAndProcessPendingWelcome failed', err);
            }
            if (welcomeResult === 'joined') return;
          }

          round++;
          if (round >= 5) {
            throw new Error('Timed out waiting for MLS group invitation');
          }

          const refreshed = await this.mlsRepo.ensureGroup(conversationId);
          currentRole = refreshed.role;
          if (currentRole === 'initiator') break;
        }
      }

      // Initiator: try an existing Welcome first (covers stale-key-package fallback).
      try {
        const welcomeResult = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
        if (welcomeResult === 'joined') return;
      } catch (err) {
        console.warn('[MLS] ensureGroupReady: initiator pre-check failed, proceeding to group creation:', err);
      }

      // Final pre-read to get credentialIdentity and confirm group is still absent.
      const freshState = await this.storage.load<StoredMlsState>(scope);
      if (!freshState) throw new Error('MLS not initialized');
      if (freshState.groupStates[conversationId]) {
        // Created concurrently (e.g. another awaited path) between the
        // pre-check above and here -- re-derive via the same solo/confirmed
        // distinction rather than assuming it's confirmed.
        const concurrentClientState = this.restoreClientState(freshState.groupStates[conversationId]);
        if (getGroupMembers(concurrentClientState).length > 1) return;
        soloStateB64 = freshState.groupStates[conversationId];
      } else {
        // ── PHASE 1: create the solo group entirely locally, persist
        //    immediately, BEFORE any network call. ──────────────────────
        const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);
        const credential: Credential = {
          credentialType: 'basic',
          identity: new TextEncoder().encode(freshState.credentialIdentity),
        };
        const selfKP = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
        const groupId = new TextEncoder().encode(conversationId);
        const soloGroupState = await createGroup(groupId, selfKP.publicPackage, selfKP.privatePackage, [], cs);
        const freshSoloStateB64 = this.bytesToBase64(encodeGroupState(soloGroupState));

        await this.storage.update<StoredMlsState>(scope, async (state) => {
          if (!state) throw new Error('MLS not initialized');
          if (state.groupStates[conversationId]) return null; // created concurrently -- don't clobber
          state.groupStates[conversationId] = freshSoloStateB64;
          state.updatedAt = Date.now();
          return state;
        });
        soloStateB64 = freshSoloStateB64;
      }
    }

    // ── PHASE 2: from the persisted solo state, add participants. ─────────
    // Re-load fresh so a resumed-from-crash entry (soloStateB64 came from
    // preState, read before any of the awaits above) always acts on the
    // truly current value for the CAS write below.
    const phase2State = await this.storage.load<StoredMlsState>(scope);
    if (!phase2State || !phase2State.groupStates[conversationId]) throw new Error('MLS not initialized');
    soloStateB64 = phase2State.groupStates[conversationId];
    const clientState = this.restoreClientState(soloStateB64);

    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    // Determine target DIDs for MLS group creation
    let targetDids: string[] = [];
    if (memberDids && memberDids.length > 0) {
      targetDids = memberDids.filter(d => d !== user.did);
    }
    if (targetDids.length === 0 && participantDid) {
      targetDids = [participantDid];
    }

    const consumedList: Array<{ keyPackage: string; deviceId: string; did: string }> = [];
    const addProposals: ProposalAdd[] = [];

    for (const did of targetDids) {
      let consumed: { keyPackage: string; deviceId: string };
      if (preConsumedKeyPackage && did === participantDid) {
        consumed = preConsumedKeyPackage;
      } else {
        try {
          consumed = await this.mlsRepo.consumeKeyPackage(did);
        } catch (err) {
          const errCode = (err as { error?: { error?: { code?: string }; code?: string } })?.error?.error?.code || (err as { error?: { code?: string } })?.error?.code;
          if (err instanceof HttpErrorResponse && errCode === 'NO_KEY_PACKAGES') {
            if (targetDids.length === 1) {
              throw new Error("This contact hasn't set up encrypted messaging yet. Ask them to open the app.");
            }
            console.warn(`[MLS] Contact ${did} has no key packages uploaded yet.`);
            continue;
          }
          if (targetDids.length === 1) throw err;
          console.warn(`[MLS] Failed to consume key package for ${did}:`, err);
          continue;
        }
      }

      const decodedKP = decodeMlsMessage(this.base64ToBytes(consumed.keyPackage), 0)?.[0];
      if (decodedKP && decodedKP.wireformat === 'mls_key_package') {
        addProposals.push({
          proposalType: 'add',
          add:          { keyPackage: decodedKP.keyPackage },
        });
        consumedList.push({ ...consumed, did });
      }
    }

    if (addProposals.length === 0) {
      // The solo state remains persisted, exactly as it was -- no marker
      // was ever written, so the NEXT ensureGroupReady() call for this
      // conversation resumes Phase 2 automatically, without redoing
      // Phase 1 (see the solo-state pre-check at the top of this method).
      throw new Error("No valid key packages available for participants. Ask them to open the app.");
    }

    const { newState: groupState, welcome, commit } = await createCommit(
      { state: clientState, cipherSuite: cs },
      { extraProposals: addProposals, wireAsPublicMessage: true, ratchetTreeExtension: true },
    );

    if (welcome) {
      const _toHex6c = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      const _refs6c  = welcome.secrets.map(s => _toHex6c(s.newMember));
      if (!environment.production) console.log(`[MLS:trace:6c] createCommit Welcome secrets count=${_refs6c.length}  refs=${_refs6c.join(' | ')}`);
    }

    const welcomeB64 = welcome ? this.bytesToBase64(encodeMlsMessage({
      version:    'mls10',
      wireformat: 'mls_welcome',
      welcome,
    })) : undefined;

    const commitB64 = this.bytesToBase64(encodeMlsMessage(commit));
    const currentEpoch = Number(clientState.groupContext.epoch); // This is 0!
    const newEpoch = Number(groupState.groupContext.epoch);

    // Every invited member's Welcome is stored in the same transaction as the
    // commit (mirrors the single-recipient DM case, generalized to N) — a
    // partial delivery (some members added to the tree but never Welcomed)
    // is no longer possible; storeMlsCommit either stores all of them or the
    // whole request fails and nothing was added.
    const welcomes = welcomeB64
      ? consumedList.map(c => ({ targetDeviceId: c.deviceId, welcome: welcomeB64 }))
      : undefined;

    // ── Atomic optimistic write + crash/restart marker ─────────────────────
    const newStateB64eg = this.bytesToBase64(encodeGroupState(groupState));
    let shouldSkip = false;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      if (state.groupStates[conversationId] !== soloStateB64) {
        // Another path (a genuine Welcome arrived concurrently, or another
        // of our own devices already completed Phase 2) already advanced
        // this conversation past the exact solo state Phase 2 was built
        // from. Never clobber it -- an exact CAS against the specific
        // previous value, not merely "does something exist" (the prior
        // check here would have wrongly treated our OWN just-persisted
        // solo state, on a resumed attempt, as "someone else already
        // initialized it").
        shouldSkip = true;
        return null;
      }
      state.groupStates[conversationId] = newStateB64eg;
      const pendingGenesises = state.pendingGenesises ?? {};
      pendingGenesises[conversationId] = {
        previousEpoch:    currentEpoch,
        previousStateB64: soloStateB64!,
        newEpoch,
      };
      state.pendingGenesises = pendingGenesises;
      state.updatedAt = Date.now();
      return state;
    });

    if (shouldSkip) return;

    // Network: post the genesis Add commit (after the storage lock has released).
    try {
      await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch, welcomes);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        console.warn('[MLS] ensureGroupReady: Epoch Conflict (409) detected on genesis. Clearing local state to force self-healing.', err);
        console.log('[MLS:observability] clearConversationGroup caller', { conversationId, caller: 'ensureGroupReady genesis 409 handler' });
        await this.clearConversationGroup(conversationId, user, device);
        this.epochConflictBus.epochConflict$.next({ conversationId });
      } else {
        // AUDIT P0 crash/restart (genesis): same reconciliation strategy as
        // provisionDevice() -- CAS rollback to the solo state, then let
        // catchUpMissedCommits() (unmodified) ask the server directly
        // whether the genesis Add commit actually landed. Never trusts
        // epoch equality as proof by itself (see the design report's
        // explicit warning) -- the rollback always happens first,
        // unconditionally, then a real server round trip decides.
        await this.reconcileGenesisAfterPostCommitFailure(conversationId, scope, newStateB64eg, soloStateB64, user, device);
      }
      throw err;
    }

    // Confirmed: the crash/restart marker written above is no longer
    // needed -- an orphaned marker after a successful commit is harmless
    // regardless (recoverOnePendingGenesis() re-validates newEpoch against
    // the CURRENT epoch before ever touching previousStateB64), but there
    // is no reason to leave it lying around.
    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state?.pendingGenesises?.[conversationId]) return null;
      delete state.pendingGenesises[conversationId];
      state.updatedAt = Date.now();
      return state;
    });

    this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64eg);

    void this.provisionAllOtherDevices(conversationId, user, device)
      .catch(err => { console.warn('[MLS] ensureGroupReady: provisionAllOtherDevices failed', err); });
  }

  // AUDIT P0 crash/restart (genesis, Phase 2 only): same pattern as
  // MlsMembershipService.reconcileAfterPostCommitFailure(), reimplemented
  // here (not imported/exposed from that private method) because genesis
  // is MlsService's own responsibility and needs no staleDeviceId/Welcome
  // reconciliation for the creator itself -- only the rollback-CAS +
  // catchUpMissedCommits() primitives are shared, both already available
  // on this service (this.storage, this.commitSvc).
  private async reconcileGenesisAfterPostCommitFailure(
    conversationId:     string,
    scope:              string,
    optimisticStateB64: string,
    previousStateB64:   string,
    user:               UserProfile,
    device:             SessionDevice,
  ): Promise<void> {
    let rolledBack = false;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      if (state.groupStates[conversationId] !== optimisticStateB64) {
        console.log('[MLS:observability] reconcileGenesisAfterPostCommitFailure rollback skipped (concurrent write detected)', { conversationId, deviceId: device.id });
        return null;
      }
      state.groupStates[conversationId] = previousStateB64;
      if (state.pendingGenesises?.[conversationId]) delete state.pendingGenesises[conversationId];
      state.updatedAt = Date.now();
      rolledBack = true;
      return state;
    });

    if (!rolledBack) return;

    console.log('[MLS:observability] reconcileGenesisAfterPostCommitFailure rolled back, reconciling with server', { conversationId, deviceId: device.id });

    try {
      const applied = await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
      console.log('[MLS:observability] reconcileGenesisAfterPostCommitFailure reconciled', { conversationId, deviceId: device.id, applied });
    } catch (reconcileErr) {
      // The reconciliation attempt itself failed (e.g. a second network
      // failure). The rollback still stands -- local state correctly
      // reflects the solo group rather than a phantom-advanced one -- so
      // this is safe to leave for the next reconnect sweep
      // (DeviceProvisioningService.checkAndProvisionOnConnect) instead of
      // retrying inline here.
      console.warn('[MLS] reconcileGenesisAfterPostCommitFailure: reconciliation attempt failed for conv', conversationId, '-- rollback still stands, will be retried on next reconnect', reconcileErr);
    }
  }

  // AUDIT P0 crash/restart (genesis, Phase 2 only): resolves any
  // ensureGroupReady() genesis operations left in pendingGenesises by a
  // crash between the optimistic Phase 2 write and postCommit()
  // confirmation. Called from DeviceProvisioningService.checkAndProvisionOnConnect()
  // on reconnect -- iterates ONLY this map (normally empty, cheap), never
  // a blind sweep of every conversation. Structurally similar to
  // MlsMembershipService.recoverPendingReprovisions()/recoverPendingRemovals()
  // but NOT a mechanical copy: genesis has no staleDeviceId/revokedDeviceId
  // and previousStateB64 is never undefined (the solo state always exists
  // by the time a Phase 2 marker could have been written).
  async recoverPendingGenesises(
    user:   UserProfile,
    device: SessionDevice,
  ): Promise<void> {
    const scope = this.makeScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    const pending = state?.pendingGenesises;
    if (!pending) return;

    for (const conversationId of Object.keys(pending)) {
      await this.recoverOnePendingGenesisDeduped(conversationId, scope, user, device);
    }
  }

  // AUDIT ADVERSARIAL P1 (section 5 fix, regression found during validation):
  // recoverOnePendingGenesis() is called from two independent places --
  // the reconnect sweep above, and ensureGroupReady()'s own pre-check below
  // -- which can genuinely race for the SAME conversationId (e.g. a live
  // ensureGroupReady() call racing the reconnect sweep right after a crash).
  // recoverOnePendingGenesis()'s own rollback-CAS is safe against a
  // concurrent DUPLICATE invocation (the loser's CAS finds the marker
  // already gone and no-ops) -- but a caller that gets that no-op back
  // cannot tell whether the WINNER has already finished reconciling
  // (catchUpMissedCommits(), a real network round trip AFTER the rollback)
  // or is still in flight. Reading storage right after a no-op can observe
  // the state mid-rollback (still solo) and wrongly conclude "needs a fresh
  // Phase 2", wastefully consuming a new KeyPackage and building a
  // redundant (harmlessly CAS-rejected, but never-should-have-happened)
  // commit. Deduping so every concurrent caller for the same conversationId
  // shares and awaits the exact same underlying attempt -- including its
  // full reconciliation -- closes this: nobody ever observes a mid-flight
  // state.
  private readonly pendingGenesisRecoveries = new Map<string, Promise<void>>();

  private recoverOnePendingGenesisDeduped(
    conversationId: string,
    scope:          string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const existing = this.pendingGenesisRecoveries.get(conversationId);
    if (existing) return existing;

    const op = this.recoverOnePendingGenesis(conversationId, scope, user, device);
    this.pendingGenesisRecoveries.set(conversationId, op);
    void op.finally(() => {
      if (this.pendingGenesisRecoveries.get(conversationId) === op) {
        this.pendingGenesisRecoveries.delete(conversationId);
      }
    });
    return op;
  }

  private async recoverOnePendingGenesis(
    conversationId: string,
    scope:          string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    let rolledBack = false;

    // Single atomic storage.update() does both the re-validation and the
    // rollback-or-drop decision -- no TOCTOU gap between reading "is this
    // marker still current" and acting on it (matches every other CAS
    // pattern in this codebase).
    await this.storage.update<StoredMlsState>(scope, async (state) => {
      const marker = state?.pendingGenesises?.[conversationId];
      if (!state || !marker) return null; // nothing pending, or already resolved (e.g. a concurrent call)

      const encoded = state.groupStates[conversationId];
      let currentEpoch: number | undefined;
      if (encoded) {
        try {
          currentEpoch = Number(this.restoreClientState(encoded).groupContext.epoch);
        } catch (err) {
          console.warn('[MLS] recoverPendingGenesises: failed to decode current state for', conversationId, '-- dropping marker without acting on it', err);
        }
      }

      // CRITICAL: currentEpoch === marker.newEpoch is NEVER treated as
      // proof that the local state IS still this marker's own phantom
      // write -- it is only a TRIGGER for the rollback-then-verify
      // sequence below, exactly like every other pendingX recovery in this
      // codebase. The actual truth always comes from the server round trip
      // in catchUpMissedCommits() after the rollback, never from this
      // epoch comparison alone.
      if (currentEpoch !== marker.newEpoch) {
        // The conversation has already moved past the phantom write this
        // marker describes (a real incoming commit, another device
        // completing Phase 2, or a prior recovery pass that already
        // resolved it) -- or the state is missing/undecodable entirely.
        // NEVER roll back over a more recent state: just drop the
        // now-obsolete marker without touching groupStates at all.
        console.log('[MLS:observability] recoverPendingGenesises marker obsolete', {
          conversationId, deviceId: device.id, currentEpoch, markerNewEpoch: marker.newEpoch,
        });
        delete state.pendingGenesises![conversationId];
        state.updatedAt = Date.now();
        return state;
      }

      console.log('[MLS:observability] recoverPendingGenesises rolling back', {
        conversationId, deviceId: device.id, previousEpoch: marker.previousEpoch, newEpoch: marker.newEpoch,
      });
      state.groupStates[conversationId] = marker.previousStateB64;
      delete state.pendingGenesises![conversationId];
      state.updatedAt = Date.now();
      rolledBack = true;
      return state;
    });

    if (!rolledBack) return;

    // Same reasoning as reconcileGenesisAfterPostCommitFailure(): once the
    // rollback lands, local state is the ordinary solo group -- ahead of
    // nothing, behind possibly the real genesis commit -- and
    // catchUpMissedCommits() (unmodified) correctly distinguishes Case A
    // (0 commits, rollback to solo stands, a fresh genesis attempt is
    // possible) from Case B/C (the real genesis commit -- ours or another
    // device's -- is found and adopted via the normal incoming-commit path).
    try {
      const applied = await this.commitSvc.catchUpMissedCommits(conversationId, user, device);
      console.log('[MLS:observability] recoverPendingGenesises reconciled', { conversationId, deviceId: device.id, applied });
    } catch (err) {
      console.warn('[MLS] recoverPendingGenesises: reconciliation attempt failed for conv', conversationId, '-- rollback still stands, an ordinary catch-up will pick it up later', err);
    }
  }

  // Thin delegate to MlsMessageCryptoService (mls-message-crypto.service.ts),
  // the real owner now -- kept on MlsService (same name) so the
  // coordinator's contract (and its spec's mockMlsSvc-based mocking)
  // doesn't need to change in this step.
  async encryptMessage(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
    text:           string,
  ): Promise<string> {
    return this.messageCryptoSvc.encryptMessage(conversationId, user, device, text);
  }

  async decryptMessage(
    conversationId:   string,
    user:             UserProfile,
    device:           SessionDevice,
    ciphertextBase64: string,
  ): Promise<string> {
    return this.messageCryptoSvc.decryptMessage(conversationId, user, device, ciphertextBase64);
  }

  // Thin delegate to MlsWelcomeService (mls-welcome.service.ts), the real
  // owner now -- kept on MlsService so the coordinator's contract (and its
  // spec's mockMlsSvc-based mocking) doesn't need to change in this step.
  async fetchAndProcessPendingWelcome(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<WelcomeProcessingResult> {
    return this.welcomeSvc.fetchAndProcessPendingWelcome(conversationId, user, device);
  }

  // Thin delegate to MlsCommitService (mls-commit.service.ts), the real
  // owner now -- kept on MlsService so the coordinator's contract (and its
  // spec's mockMlsSvc-based mocking) doesn't need to change in this step.
  async catchUpMissedCommits(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<number> {
    return this.commitSvc.catchUpMissedCommits(conversationId, user, device);
  }

  // Thin delegate to MlsWelcomeService (mls-welcome.service.ts), the real
  // owner now -- kept on MlsService so the coordinator's contract (and its
  // spec's mockMlsSvc-based mocking) doesn't need to change in this step.
  async processWelcomeForConversation(
    welcomeId:      string | null,
    welcomeBase64:  string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<WelcomeProcessingResult> {
    return this.welcomeSvc.processWelcomeForConversation(welcomeId, welcomeBase64, conversationId, user, device);
  }

  // ── Conversation preparation ───────────────────────────────────────────────

  async prepareConversationInitialization(
    currentUser:    UserProfile,
    currentDevice:  SessionDevice,
    participantDid: string,
  ): Promise<PreparedConversationInitialization> {
    // Network call before the storage lock.
    const page = await this.mlsRepo.getKeyPackagesForParticipant(participantDid);

    const keyPackages = page.data.map(item => {
      const decoded = decodeMlsMessage(this.base64ToBytes(item.keyPackage), 0)?.[0];
      if (!decoded || decoded.wireformat !== 'mls_key_package') {
        throw new Error('Received an invalid MLS key package from the backend.');
      }
      return { id: item.id, deviceId: item.deviceId, keyPackage: decoded.keyPackage };
    });

    const scope = this.makeScope(currentUser.did, currentDevice.id);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      state.conversations[participantDid] = {
        participantDid,
        remoteDeviceIds: keyPackages.map(item => item.deviceId),
        preparedAt:      Date.now(),
      };
      state.updatedAt = Date.now();
      return state;
    });

    return {
      participantDid,
      initiatorDeviceId: currentDevice.id,
      keyPackages,
    };
  }

  // Returns true if the local MLS group state exists for this conversation.
  async hasGroupState(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<boolean> {
    const scope = this.makeScope(user.did, device.id);
    const state = await this.storage.load<StoredMlsState>(scope);
    return !!(state?.groupStates[conversationId]);
  }

  // Injects restored MLS group states from a backup into local storage.
  // Only injects states for conversations without an existing local state.
  // Returns the conversationIds actually injected (a subset of the input:
  // an existing local group state is never overwritten, and a candidate
  // whose epoch regresses below what this device is known to have already
  // reached -- per the tombstone recorded by clearConversationGroup() -- is
  // refused rather than silently adopted).
  async injectRestoredGroupStates(
    groupStates: Record<string, string>,
    user:        UserProfile,
    device:      SessionDevice,
  ): Promise<string[]> {
    if (Object.keys(groupStates).length === 0) return [];

    const scope = this.makeScope(user.did, device.id);
    const injectedIds: string[] = [];

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      let injected = false;
      for (const [convId, gs] of Object.entries(groupStates)) {
        if (state.groupStates[convId]) continue;

        const lastKnownEpoch = state.lastKnownEpochs?.[convId];
        if (lastKnownEpoch !== undefined) {
          let restoredEpoch: number;
          try {
            restoredEpoch = Number(this.restoreClientState(gs).groupContext.epoch);
          } catch (err) {
            console.warn('[MLS] injectRestoredGroupStates: failed to decode candidate for', convId, ':', err);
            continue;
          }
          if (restoredEpoch < lastKnownEpoch) {
            console.log('[MLS:observability] injectRestoredGroupStates refused', {
              conversationId: convId, restoredEpoch, lastKnownEpoch, result: 'refused_stale_backup',
            });
            continue;
          }
        }

        state.groupStates[convId] = gs;
        injectedIds.push(convId);
        injected = true;
      }
      if (!injected) return null;
      state.updatedAt = Date.now();
      return state;
    });

    return injectedIds;
  }

  // Thin delegate to MlsMembershipService (mls-membership.service.ts), the
  // real owner now -- kept on MlsService (same name) so both the
  // coordinator's contract and this file's own internal call sites
  // (provisionAllOtherDevices) don't need to change in this step.
  async provisionDevice(
    newDeviceId:    string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.provisionDevice(newDeviceId, conversationId, user, device);
  }

  // Thin delegate to MlsMembershipService (mls-membership.service.ts), the
  // real owner now -- kept on MlsService (same name) so the coordinator's
  // contract (and its spec's mockMlsSvc-based mocking) doesn't change.
  async reprovisionLostStateDevice(
    staleDeviceId:  string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.reprovisionLostStateDevice(staleDeviceId, conversationId, user, device);
  }

  // Thin delegate to MlsMembershipService (mls-membership.service.ts), the
  // real owner now -- kept on MlsService (same name) since ensureGroupReady
  // below still calls it internally.
  async provisionAllOtherDevices(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.provisionAllOtherDevices(conversationId, user, device);
  }

  // Thin delegate to MlsMembershipService (mls-membership.service.ts), the
  // real owner now -- see that file's class comment for why this moved
  // there instead of staying implemented here.
  async clearConversationGroup(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.clearConversationGroup(conversationId, user, device);
  }

  // Thin delegate to MlsCommitService (mls-commit.service.ts), the real
  // owner now -- kept on MlsService (same name) so both the coordinator's
  // contract and this file's own internal call sites (provisionDevice /
  // reprovisionLostStateDevice / removeRevokedDeviceFromAllGroups, still
  // living here until Step 3) don't need to change in this step.
  processIncomingCommit(
    conversationId: string,
    commitBase64:   string,
    epoch:          number,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    return this.commitSvc.processIncomingCommit(conversationId, commitBase64, epoch, user, device);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  // Thin delegates to MlsCryptoContextService (mls-crypto-context.service.ts),
  // the real owner now -- kept here so the many call sites below don't all
  // need touching in this same step. Call sites migrate to `this.cryptoCtx.X`
  // directly as each method physically moves to its own sub-service.
  private restoreClientState(base64: string): ClientState {
    return this.cryptoCtx.restoreClientState(base64);
  }

  private buildCredentialIdentity(userDid: string, deviceId: string): string {
    return this.cryptoCtx.buildCredentialIdentity(userDid, deviceId);
  }

  private makeScope(userDid: string, deviceId: string): string {
    return this.cryptoCtx.makeScope(userDid, deviceId);
  }

  private bytesToBase64(value: Uint8Array): string {
    return this.cryptoCtx.bytesToBase64(value);
  }

  private base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    return this.cryptoCtx.base64ToBytes(value);
  }

  private async _sha256hex(data: Uint8Array<ArrayBufferLike>): Promise<string> {
    return this.cryptoCtx.sha256hex(data);
  }

  // Thin delegate to MlsMembershipService (mls-membership.service.ts), the
  // real owner now -- kept on MlsService (same name) so the coordinator's
  // contract (and its spec's mockMlsSvc-based mocking) doesn't change.
  async removeRevokedDeviceFromAllGroups(
    revokedDeviceId: string,
    user:            UserProfile,
    device:          SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.removeRevokedDeviceFromAllGroups(revokedDeviceId, user, device);
  }

  // Thin delegate to MlsMembershipService.isDeviceMemberLocally() (AUDIT P1
  // crash/restart detection) -- see that method's doc comment.
  async isDeviceMemberLocally(
    conversationId: string,
    deviceId:       string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<boolean> {
    return this.membershipSvc.isDeviceMemberLocally(conversationId, deviceId, user, device);
  }

  // Thin delegate to MlsMembershipService.recoverPendingReprovisions()
  // (AUDIT P1 crash/restart for reprovisionLostStateDevice()) -- see that
  // method's doc comment.
  async recoverPendingReprovisions(
    user:   UserProfile,
    device: SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.recoverPendingReprovisions(user, device);
  }

  // Thin delegate to MlsMembershipService.recoverPendingRemovals() (AUDIT
  // P0 crash/restart for removeRevokedDeviceFromAllGroups()) -- see that
  // method's doc comment.
  async recoverPendingRemovals(
    user:   UserProfile,
    device: SessionDevice,
  ): Promise<void> {
    return this.membershipSvc.recoverPendingRemovals(user, device);
  }
}
