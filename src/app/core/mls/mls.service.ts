import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject } from 'rxjs';
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
import { getGroupMembers }  from 'ts-mls/clientState.js';
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

  // Thin delegate, kept so the many call sites below don't all need touching
  // in this same step -- MlsCryptoContextService (mls-crypto-context.service.ts)
  // is the real owner now. Call sites migrate to `this.cryptoCtx.X` directly
  // as each method physically moves to its own sub-service in later steps.
  private get cipherSuiteName(): typeof this.cryptoCtx.cipherSuiteName {
    return this.cryptoCtx.cipherSuiteName;
  }

  readonly epochConflict$ = new Subject<{ conversationId: string }>();

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

    const scope = this.makeScope(user.did, device.id);

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
    const preClientState = this.restoreClientState(preState.groupStates[conversationId]);
    if (this.isDeviceMember(preClientState, newDeviceId)) {
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
      if (err instanceof HttpErrorResponse && (err.error as { code?: string })?.code === 'NO_KEY_PACKAGES') {
        console.warn('[MLS] provisionDevice: no key packages for', newDeviceId, '— cannot provision conv', conversationId);
      }
      throw err;
    }

    const decodedKP = decodeMlsMessage(this.base64ToBytes(consumed.keyPackage), 0)?.[0];
    if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') {
      throw new Error('Invalid key package received from server');
    }

    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

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

      const clientState = this.restoreClientState(encoded);
      currentEpoch = Number(clientState.groupContext.epoch);

      // Guard inside the lock: verify device is not already a member.
      // This prevents the TOCTOU race where two concurrent provisionDevice calls
      // both consumed a KP before entering this lock.
      if (this.isDeviceMember(clientState, newDeviceId)) {
        if (!environment.production) console.log('[MLS] provisionDevice: device already member (inside lock), skipping', newDeviceId, conversationId);
        shouldSkip = true;
        return null;
      }

      const { newState, welcome, commit } = await createCommit(
        { state: clientState, cipherSuite: cs },
        { extraProposals: [addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );

      if (!welcome) throw new Error('createCommit returned no welcome for device provisioning');

      welcomeB64 = this.bytesToBase64(encodeMlsMessage({
        version:    'mls10',
        wireformat: 'mls_welcome',
        welcome,
      }));
      commitB64       = this.bytesToBase64(encodeMlsMessage(commit));
      newEpoch        = Number(newState.groupContext.epoch);
      previousStateB64pd = state.groupStates[conversationId];
      newStateB64pd      = this.bytesToBase64(encodeGroupState(newState));

      state.groupStates[conversationId] = newStateB64pd;
      state.updatedAt = Date.now();
      return state;
    });

    if (shouldSkip) return;

    // Network: post Welcome and Commit atomically (after the storage lock).
    let stored;
    try {
      stored = await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch!, {
        targetDeviceId: newDeviceId,
        welcome: welcomeB64,
      });
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        console.warn('[MLS] provisionDevice: Epoch Conflict (409) detected. Clearing local state to force self-healing.', err);
        console.log('[MLS:observability] clearConversationGroup caller', { conversationId, caller: 'provisionDevice 409 handler' });
        await this.clearConversationGroup(conversationId, user, device);
        this.epochConflict$.next({ conversationId });
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
      await this.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
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

    const scope = this.makeScope(user.did, device.id);

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
      if (err instanceof HttpErrorResponse && (err.error as { code?: string })?.code === 'NO_KEY_PACKAGES') {
        console.warn('[MLS] reprovisionLostStateDevice: no key packages for', staleDeviceId, '— cannot reprovision conv', conversationId);
      }
      throw err;
    }

    const decodedKP = decodeMlsMessage(this.base64ToBytes(consumed.keyPackage), 0)?.[0];
    if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') {
      throw new Error('Invalid key package received from server');
    }

    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

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

      const clientState = this.restoreClientState(encoded);
      currentEpoch = Number(clientState.groupContext.epoch);

      // Find the stale device's current leaf. If it's no longer a member,
      // another device already fixed it (or it was never a member to begin
      // with) — skip idempotently rather than attempt a Remove for a leaf
      // that doesn't exist.
      const members = getGroupMembers(clientState);
      const dec = new TextDecoder();
      const leafIndex = members.findIndex((m: ReturnType<typeof getGroupMembers>[number]) =>
        m.credential.credentialType === 'basic' &&
        dec.decode(m.credential.identity).endsWith(`#${staleDeviceId}`)
      );

      if (leafIndex === -1) {
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

      welcomeB64 = this.bytesToBase64(encodeMlsMessage({
        version:    'mls10',
        wireformat: 'mls_welcome',
        welcome,
      }));
      commitB64       = this.bytesToBase64(encodeMlsMessage(commit));
      newEpoch        = Number(newState.groupContext.epoch);
      previousStateB64pd = state.groupStates[conversationId];
      newStateB64pd      = this.bytesToBase64(encodeGroupState(newState));

      state.groupStates[conversationId] = newStateB64pd;
      state.updatedAt = Date.now();
      return state;
    });

    if (shouldSkip) return;

    // Network: post Welcome and Commit atomically (after the storage lock).
    let stored;
    try {
      stored = await this.mlsRepo.postCommit(conversationId, commitB64, currentEpoch!, {
        targetDeviceId: staleDeviceId,
        welcome: welcomeB64,
      });
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        console.warn('[MLS] reprovisionLostStateDevice: Epoch Conflict (409) detected. Clearing local state to force self-healing.', err);
        console.log('[MLS:observability] clearConversationGroup caller', { conversationId, caller: 'reprovisionLostStateDevice 409 handler' });
        await this.clearConversationGroup(conversationId, user, device);
        this.epochConflict$.next({ conversationId });
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
      await this.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
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
    const scope = this.makeScope(user.did, device.id);

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
          const epoch = Number(this.restoreClientState(encoded).groupContext.epoch);
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
  private isDeviceMember(clientState: ClientState, deviceId: string): boolean {
    return this.cryptoCtx.isDeviceMember(clientState, deviceId);
  }

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

  async removeRevokedDeviceFromAllGroups(
    revokedDeviceId: string,
    user:            UserProfile,
    device:          SessionDevice,
  ): Promise<void> {
    const scope = this.getStorageScope(user.did, device.id);
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
      // shape (:842-931) — doing them inside this same-scope updater used
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
        const clientState = this.restoreClientState(encoded);
        currentEpoch = Number(clientState.groupContext.epoch);
        const members = getGroupMembers(clientState);
        const dec = new TextDecoder();

        // getGroupMembers() returns leaves in tree order with no attached index —
        // the array position IS the leaf index (see provisionDevice's identical
        // "already member" lookup above, which relies on the same ordering).
        const leafIndex = members.findIndex((m) =>
          m.credential.credentialType === 'basic' &&
          dec.decode(m.credential.identity).endsWith(`#${revokedDeviceId}`)
        );

        if (leafIndex === -1) {
          shouldSkip = true;
          return null;
        }

        if (!environment.production) console.warn('[MLS] removeRevokedDevice: found device to remove in conv', convId, revokedDeviceId, 'at leaf', leafIndex);

        const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);
        const removeProposal = {
          proposalType: 'remove' as const,
          remove: { removed: leafIndex },
        };

        const { newState, commit } = await createCommit(
          { state: clientState, cipherSuite: cs },
          { extraProposals: [removeProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
        );

        commitB64            = this.bytesToBase64(encodeMlsMessage(commit));
        previousStateB64rrd  = current.groupStates[convId];
        newStateB64rrd       = this.bytesToBase64(encodeGroupState(newState));

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
          this.epochConflict$.next({ conversationId: convId });
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
        void this.processIncomingCommit(convId, stored.commit, stored.epoch, user, device)
          .catch(err => console.warn('[MLS] removeRevokedDevice: resync after lost race failed for conv', convId, err));
      }
    }
  }
}
