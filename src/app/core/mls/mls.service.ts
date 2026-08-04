import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  acceptAll,
  createApplicationMessage,
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
  emptyPskIndex,
  encodeMlsMessage,
  encodeGroupState,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  processPrivateMessage,
  type ClientConfig,
  type ClientState,
  type Credential,
  type KeyPackage,
  type PrivateKeyPackage,
  type ProposalAdd,
} from 'ts-mls';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
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

    let consumed: { keyPackage: string; deviceId: string };
    if (preConsumedKeyPackage) {
      consumed = preConsumedKeyPackage;
    } else {
      try {
        consumed = await this.mlsRepo.consumeKeyPackage(participantDid);
      } catch (err) {
        if (err instanceof HttpErrorResponse && (err.error as { code?: string })?.code === 'NO_KEY_PACKAGES') {
          throw new Error("This contact hasn't set up encrypted messaging yet. Ask them to open the app.");
        }
        throw err;
      }
    }

    const decodedKP = decodeMlsMessage(this.base64ToBytes(consumed.keyPackage), 0)?.[0];
    if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') {
      throw new Error('Invalid key package received from server');
    }
    const _sha256_6a = await this._sha256hex(this.base64ToBytes(consumed.keyPackage));
    if (!environment.production) console.log(`[MLS:trace:6a] consumed KP from backend  deviceId=${consumed.deviceId}  sha256=${_sha256_6a}  b64fp=${consumed.keyPackage.substring(0, 48)}`);

    const addProposal: ProposalAdd = {
      proposalType: 'add',
      add:          { keyPackage: decodedKP.keyPackage },
    };
    if (!environment.production) console.log(`[MLS:trace:6b] createCommit using addProposal  b64fp=${consumed.keyPackage.substring(0, 48)}`);
    const { newState: groupState, welcome, commit } = await createCommit(
      { state: initialGroupState, cipherSuite: cs },
      { extraProposals: [addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
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

    await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch, welcomeB64 ? {
      targetDeviceId: consumed.deviceId,
      welcome: welcomeB64,
    } : undefined);

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

  // Encrypts a plaintext string for the given conversation.
  async encryptMessage(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
    text:           string,
  ): Promise<string> {
    // Await any in-progress commit before entering the storage lock so that
    // the outgoing message uses the epoch produced by the latest commit.
    const pending = this.pendingCommitTracker.get(conversationId);
    if (pending) await pending;

    const scope = this.makeScope(user.did, device.id);
    const cs    = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    let ciphertextB64!: string;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) throw new Error('MLS group not ready for this conversation');

      const clientState = this.restoreClientState(encoded);
      const { newState, privateMessage } = await createApplicationMessage(
        clientState,
        new TextEncoder().encode(text),
        cs,
      );

      ciphertextB64 = this.bytesToBase64(encodeMlsMessage({
        version:        'mls10',
        wireformat:     'mls_private_message',
        privateMessage,
      }));

      state.groupStates[conversationId] = this.bytesToBase64(encodeGroupState(newState));
      state.updatedAt = Date.now();
      return state;
    });

    return ciphertextB64;
  }

  // Decrypts a base64-encoded MLS private message for the given conversation.
  async decryptMessage(
    conversationId:   string,
    user:             UserProfile,
    device:           SessionDevice,
    ciphertextBase64: string,
  ): Promise<string> {
    // Await any in-progress commit before entering the storage lock.
    const pending = this.pendingCommitTracker.get(conversationId);
    if (pending) await pending;

    const scope = this.makeScope(user.did, device.id);
    const cs    = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    // Decode message bytes outside lock (no state dependency).
    const msgBytes = this.base64ToBytes(ciphertextBase64);
    const decoded  = decodeMlsMessage(msgBytes, 0)?.[0];
    if (!decoded || decoded.wireformat !== 'mls_private_message') {
      throw new Error('Invalid MLS message');
    }

    let plaintext!: string;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) throw new Error('MLS group not ready for this conversation');

      const clientState = this.restoreClientState(encoded);
      const result = await processPrivateMessage(
        clientState,
        decoded.privateMessage,
        emptyPskIndex,
        cs,
        acceptAll,
      );

      if (result.kind !== 'applicationMessage') {
        throw new Error('Expected application message, got handshake');
      }

      plaintext = new TextDecoder().decode(result.message);
      state.groupStates[conversationId] = this.bytesToBase64(encodeGroupState(result.newState));
      state.updatedAt = Date.now();
      return state;
    });

    return plaintext;
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

  // Called by KeyPackageService to generate key package records.
  async generateKeyPackages(
    userDid:  string,
    deviceId: string,
    count:    number,
  ): Promise<StoredKeyPackageRecord[]> {
    if (count <= 0) return [];

    const credentialIdentity = this.buildCredentialIdentity(userDid, deviceId);
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);
    const credential: Credential = {
      credentialType: 'basic',
      identity: new TextEncoder().encode(credentialIdentity),
    };

    const generated: StoredKeyPackageRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const keyPackage = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);

      generated.push({
        serverId:             null,
        deviceId,
        serializedKeyPackage: this.bytesToBase64(encodeMlsMessage({
          version:    'mls10',
          wireformat: 'mls_key_package',
          keyPackage: keyPackage.publicPackage,
        })),
        privatePackage: this.serializePrivatePackage(keyPackage.privatePackage),
        createdAt:      Date.now(),
      });
      const _rec1       = generated[generated.length - 1]!;
      const _toHex1     = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      const _kpBytes1   = this.base64ToBytes(_rec1.serializedKeyPackage);
      const _kpSha256_1 = await this._sha256hex(_kpBytes1);
      const _kpRef1     = _toHex1(await makeKeyPackageRef(keyPackage.publicPackage, cs.hash));
      const _initSha1   = await this._sha256hex(keyPackage.privatePackage.initPrivateKey);
      if (!environment.production) console.log(`[MLS:trace:1] KP generated  index=${i}  deviceId=${deviceId}  sha256=${_kpSha256_1}  kpRef=${_kpRef1}  initPrivSha256=${_initSha1}  b64fp=${_rec1.serializedKeyPackage.substring(0, 48)}`);
    }

    return generated;
  }

  // Called by KeyPackageService after uploading generated records to the server.
  async appendKeyPackagesToState(
    userDid:  string,
    deviceId: string,
    records:  StoredKeyPackageRecord[],
  ): Promise<void> {
    const scope = this.makeScope(userDid, deviceId);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      // Deduplicate by serializedKeyPackage to prevent double-append on concurrent calls.
      const existingKPs = new Set(state.keyPackages.map(kp => kp.serializedKeyPackage));
      const fresh = records.filter(r => !existingKPs.has(r.serializedKeyPackage));
      state.keyPackages = [...state.keyPackages, ...fresh];
      if (!environment.production) {
        console.log(`[MLS:trace:2] appendKeyPackagesToState  total=${state.keyPackages.length}`);
        state.keyPackages.forEach((kp, i) => {
          console.log(`[MLS:trace:2]   slot=${i}  serverId=${kp.serverId}  b64fp=${kp.serializedKeyPackage.substring(0, 48)}`);
        });
      }
      state.updatedAt = Date.now();
      return state;
    });

    if (!environment.production) {
      const _verState = await this.storage.load<StoredMlsState>(scope);
      console.log(`[MLS:trace:2b] VERIFY post-append  stored=${_verState?.keyPackages.length}  submitted=${records.length}`);
      await Promise.all(records.map(async (r) => {
        const sha256In   = await this._sha256hex(this.base64ToBytes(r.serializedKeyPackage));
        const storedRec  = _verState?.keyPackages.find(k => k.serverId === r.serverId);
        const sha256Stor = storedRec
          ? await this._sha256hex(this.base64ToBytes(storedRec.serializedKeyPackage))
          : 'NOT_FOUND';
        const result = sha256In === sha256Stor ? 'IDENTICAL' : 'DIFFERENT ←';
        console.log(`[MLS:trace:2b]   serverId=${r.serverId}  sha256In=${sha256In}  sha256Stored=${sha256Stor}  result=${result}`);
      }));
    }
  }

  private buildCredentialIdentity(userDid: string, deviceId: string): string {
    return this.cryptoCtx.buildCredentialIdentity(userDid, deviceId);
  }

  private makeScope(userDid: string, deviceId: string): string {
    return this.cryptoCtx.makeScope(userDid, deviceId);
  }

  getStorageScope(userDid: string, deviceId: string): string {
    return this.cryptoCtx.getStorageScope(userDid, deviceId);
  }

  private serializePrivatePackage(value: PrivateKeyPackage): SerializedPrivateKeyPackage {
    return this.cryptoCtx.serializePrivatePackage(value);
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
}
