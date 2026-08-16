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

    if (preState.groupStates[conversationId]) {
      // In case we missed the Socket.IO welcome event while offline or disconnected,
      // check if there is a pending Welcome for us on the server. If there is, it means
      // the group was reset by another device, so our local state is obsolete.
      try {
        const joined = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
        if (joined && !environment.production) {
          console.log('[MLS] ensureGroupReady: successfully healed group from welcome on page load', conversationId);
        }
      } catch (err) {
        console.warn('[MLS] ensureGroupReady: background welcome check failed', err);
      }
      return;
    }

    // The backend is the single authority on who creates the MLS group.
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

          let joined = false;
          try {
            joined = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
          } catch (err) {
            console.warn('[MLS] ensureGroupReady: fetchAndProcessPendingWelcome failed', err);
          }
          if (joined) return;
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
      const joined = await this.fetchAndProcessPendingWelcome(conversationId, user, device);
      if (joined) return;
    } catch (err) {
      console.warn('[MLS] ensureGroupReady: initiator pre-check failed, proceeding to group creation:', err);
    }

    // Final pre-read to get credentialIdentity and confirm group is still absent.
    const freshState = await this.storage.load<StoredMlsState>(scope);
    if (!freshState) throw new Error('MLS not initialized');
    if (freshState.groupStates[conversationId]) return;

    // ── All expensive work below runs OUTSIDE the storage lock ───────────────

    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    const credential: Credential = {
      credentialType: 'basic',
      identity: new TextEncoder().encode(freshState.credentialIdentity),
    };
    const selfKP = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
    const groupId = new TextEncoder().encode(conversationId);
    const initialGroupState = await createGroup(groupId, selfKP.publicPackage, selfKP.privatePackage, [], cs);

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
      throw new Error("No valid key packages available for participants. Ask them to open the app.");
    }

    const { newState: groupState, welcome, commit } = await createCommit(
      { state: initialGroupState, cipherSuite: cs },
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
    const currentEpoch = Number(initialGroupState.groupContext.epoch); // This is 0!

    // Every invited member's Welcome is stored in the same transaction as the
    // commit (mirrors the single-recipient DM case, generalized to N) — a
    // partial delivery (some members added to the tree but never Welcomed)
    // is no longer possible; storeMlsCommit either stores all of them or the
    // whole request fails and nothing was added.
    const welcomes = welcomeB64
      ? consumedList.map(c => ({ targetDeviceId: c.deviceId, welcome: welcomeB64 }))
      : undefined;

    await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch, welcomes);

    // ── Atomic state write ────────────────────────────────────────────────────

    const newStateB64eg      = this.bytesToBase64(encodeGroupState(groupState));
    let   previousStateB64eg: string | undefined;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      if (state.groupStates[conversationId]) {
        // Another path (Welcome received while we were doing crypto) already
        // initialized the group. Keep the existing state intact.
        return null;
      }
      previousStateB64eg = state.groupStates[conversationId];
      state.groupStates[conversationId] = newStateB64eg;
      state.updatedAt = Date.now();
      return state;
    });

    if (newStateB64eg !== previousStateB64eg) {
      this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64eg);
    }

    void this.provisionAllOtherDevices(conversationId, user, device)
      .catch(err => { console.warn('[MLS] ensureGroupReady: provisionAllOtherDevices failed', err); });
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
  ): Promise<boolean> {
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
  ): Promise<void> {
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
}
