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
  joinGroup,
  processPrivateMessage,
  processPublicMessage,
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
import type {
  SerializedPrivateKeyPackage,
  StoredKeyPackageRecord,
  PreparedConversationState,
  StoredMlsState,
} from './mls.types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionDevice {
  id:       string;
  name:     string;
  platform: string;
}

export type { UploadedKeyPackage } from './mls.types';

export type {
  SerializedPrivateKeyPackage,
  StoredKeyPackageRecord,
  PreparedConversationState,
  StoredMlsState,
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

type BackupServiceLike = { backupGroupState(conversationId: string, stateB64: string): void };

@Injectable({ providedIn: 'root' })
export class MlsService {
  private readonly mlsRepo = inject(MlsRepository);
  private readonly storage = inject(MlsStateStorageService);

  private readonly cipherSuiteName = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

  // Per-conversation serialization queue for incoming Commit processing.
  // processIncomingCommit() chains onto this promise and registers the new one
  // synchronously (before any await) so that decryptMessage/encryptMessage can
  // await it before entering the storage lock — eliminating the race between an
  // arriving mls:commit event and the next message:new event.
  private readonly pendingCommits = new Map<string, Promise<void>>();

  // Registered by BackupService at construction time to avoid a circular DI cycle.
  private backupSvcRef: BackupServiceLike | null = null;

  setBackupService(svc: BackupServiceLike): void {
    this.backupSvcRef = svc;
  }

  // ── Session initialization ─────────────────────────────────────────────────

  async initializeForSession(user: UserProfile, device: SessionDevice): Promise<void> {
    const scope = this.makeScope(user.did, device.id);

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
        if (round >= 2) {
          // Deadlock escape: we are stuck waiting for a Welcome.
          // Force a group reset on the backend by ACKing all pending welcomes,
          // clearing local group state, and retrying ensureGroup.
          if (!environment.production) console.warn('[MLS] ensureGroupReady: stuck waiting for Welcome, forcing group reset for', conversationId);
          try {
            const welcomes = await this.mlsRepo.getPendingWelcomes(conversationId);
            for (const item of welcomes.data) {
              await this.mlsRepo.ackWelcome(item.id).catch(() => {});
            }
            await this.clearConversationGroup(conversationId, user, device);
          } catch (err) {
            console.error('[MLS] ensureGroupReady: failed during deadlock escape', err);
          }
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
    const { newState: groupState, welcome } = await createCommit(
      { state: initialGroupState, cipherSuite: cs },
      { extraProposals: [addProposal], ratchetTreeExtension: true },
    );

    if (welcome) {
      const _toHex6c = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      const _refs6c  = welcome.secrets.map(s => _toHex6c(s.newMember));
      if (!environment.production) console.log(`[MLS:trace:6c] createCommit Welcome secrets count=${_refs6c.length}  refs=${_refs6c.join(' | ')}`);
    }

    // Post the Welcome (network, before the atomic state write).
    if (welcome) {
      await this.mlsRepo.postWelcome(
        consumed.deviceId,
        this.bytesToBase64(encodeMlsMessage({
          version:    'mls10',
          wireformat: 'mls_welcome',
          welcome,
        })),
        conversationId,
      );
    } else {
      console.warn('[MLS] ensureGroupReady: createCommit returned no welcome for', conversationId);
    }

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
      this.backupSvcRef?.backupGroupState(conversationId, newStateB64eg);
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
    const pending = this.pendingCommits.get(conversationId);
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
    const pending = this.pendingCommits.get(conversationId);
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

  // Fetches unconsumed Welcomes from the server and processes them.
  async fetchAndProcessPendingWelcome(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<boolean> {
    const response = await this.mlsRepo.getPendingWelcomes(conversationId);

    if (response.data.length === 0) return false;

    let processed = false;
    for (const item of response.data) {
      try {
        await this.processWelcomeForConversation(item.id, item.welcome, conversationId, user, device);
        processed = true;
      } catch (err) {
        console.warn('[MLS] fetchAndProcessPendingWelcome: failed to process Welcome', item.id, ':', err);
      }
    }
    return processed;
  }

  // Fetches and applies any MLS commits missed while offline.
  async catchUpMissedCommits(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const scope = this.makeScope(user.did, device.id);

    // Read-only pre-check to get the current epoch for the query parameter.
    const state = await this.storage.load<StoredMlsState>(scope);
    if (!state) return;
    const encoded = state.groupStates[conversationId];
    if (!encoded) return;

    const clientState  = this.restoreClientState(encoded);
    const currentEpoch = Number(clientState.groupContext.epoch);

    const response = await this.mlsRepo.getMissedCommits(conversationId, currentEpoch);

    if (response.data.length === 0) return;

    if (!environment.production) console.log('[MLS] catchUpMissedCommits: applying', response.data.length, 'missed commit(s) from epoch', currentEpoch, 'for conv', conversationId);
    for (const item of response.data) {
      await this.processIncomingCommit(conversationId, item.commit, item.epoch, user, device);
    }
  }

  // Processes an incoming Welcome and joins the corresponding MLS group.
  // The joinGroup crypto runs outside the storage lock; the state write is atomic.
  async processWelcomeForConversation(
    welcomeId:      string | null,
    welcomeBase64:  string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const scope = this.makeScope(user.did, device.id);

    // Parse the Welcome outside the lock (no state dependency).
    const welcomeBytes   = this.base64ToBytes(welcomeBase64);
    const welcomeMessage = decodeMlsMessage(welcomeBytes, 0)?.[0];
    if (!welcomeMessage || welcomeMessage.wireformat !== 'mls_welcome') {
      throw new Error('Invalid Welcome message');
    }

    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    // Pre-read to get the key package list for Welcome matching.
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');

    // Idempotence: if this Welcome was already processed on this device, ACK and return.
    if (welcomeId && preState.processedWelcomeIds?.includes(welcomeId)) {
      if (!environment.production) console.log('[MLS] processWelcomeForConversation: Welcome already processed, ACKing:', welcomeId);
      this.ackWelcome(welcomeId);
      return;
    }

    const _toHex = (b: Uint8Array) =>
      Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    const _welcomeRefs = welcomeMessage.welcome.secrets.map(s => _toHex(s.newMember));
    if (!environment.production) {
      console.log(`[MLS:trace:7] Welcome secrets count=${_welcomeRefs.length}  refs=${_welcomeRefs.join(' | ')}`);
      console.log(`[MLS:trace:7] Local state keyPackages count=${preState.keyPackages.length}`);
    }

    // Try each key package OUTSIDE the lock (joinGroup is crypto-only).
    let matchedKpB64: string | null = null;
    let joinedGroupState: Awaited<ReturnType<typeof joinGroup>> | null = null;

    let kpIndex = 0;
    for (const kpRecord of preState.keyPackages) {
      try {
        const kpBytes   = this.base64ToBytes(kpRecord.serializedKeyPackage);
        const kpDecoded = decodeMlsMessage(kpBytes, 0)?.[0];
        if (!kpDecoded || kpDecoded.wireformat !== 'mls_key_package') {
          kpIndex++; continue;
        }

        const _kpRef8     = _toHex(await makeKeyPackageRef(kpDecoded.keyPackage, cs.hash));
        const _kpB64fp    = kpRecord.serializedKeyPackage.substring(0, 48);
        const _kpSha256_8 = await this._sha256hex(kpBytes);
        const _match8     = _welcomeRefs.some(r => r === _kpRef8);
        if (!environment.production) console.log(`[MLS:trace:8]   KP index=${kpIndex}  sha256=${_kpSha256_8}  computedRef=${_kpRef8}  b64fp=${_kpB64fp}  matches=${_match8 ? 'YES ←' : 'no'}`);

        const privateKeys: PrivateKeyPackage = {
          initPrivateKey:      this.base64ToBytes(kpRecord.privatePackage.initPrivateKey),
          hpkePrivateKey:      this.base64ToBytes(kpRecord.privatePackage.hpkePrivateKey),
          signaturePrivateKey: this.base64ToBytes(kpRecord.privatePackage.signaturePrivateKey),
        };

        const groupState = await joinGroup(
          welcomeMessage.welcome,
          kpDecoded.keyPackage,
          privateKeys,
          emptyPskIndex,
          cs,
        );

        matchedKpB64    = kpRecord.serializedKeyPackage;
        joinedGroupState = groupState;
        break;
      } catch (err) {
        console.warn('[MLS] joinGroup failed for KP index', kpIndex, ':', err);
      }
      kpIndex++;
    }

    if (matchedKpB64 === null || joinedGroupState === null) {
      console.error(`[MLS:audit] ========================`);
      console.error(`[MLS:audit] AUCUN KEYPACKAGE NE CORRESPOND`);
      console.error(`[MLS:audit] Welcome refs (${_welcomeRefs.length}): ${_welcomeRefs.join(' | ')}`);
      console.error(`[MLS:audit] Tried ${preState.keyPackages.length} local KPs — see trace:8 above`);
      console.error(`[MLS:audit] ========================`);
      if (!environment.production) {
        console.log(`[MLS:trace:8] FINAL  Welcome expected refs: ${_welcomeRefs.join(' | ')}`);
        console.log(`[MLS:trace:8] FINAL  No local KP matched. All tried refs above.`);
      }
      if (welcomeId) {
        console.warn('[MLS] processWelcomeForConversation: no matching KP for Welcome', welcomeId, '— ACKing stale');
        this.ackWelcome(welcomeId);
      }
      throw new Error(`No matching key package found for Welcome (tried ${preState.keyPackages.length})`);
    }

    // ── Atomic state write ────────────────────────────────────────────────────

    const newStateB64wfc      = this.bytesToBase64(encodeGroupState(joinedGroupState));
    const consumedKpB64       = matchedKpB64;
    let   previousStateB64wfc: string | undefined;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      previousStateB64wfc = state.groupStates[conversationId];
      // Remove the consumed key package by identity (index-independent, idempotent).
      state.keyPackages = state.keyPackages.filter(
        kp => kp.serializedKeyPackage !== consumedKpB64,
      );
      state.groupStates[conversationId] = newStateB64wfc;
      // Record processed welcomeId for idempotent re-delivery handling (max 200, FIFO).
      if (welcomeId) {
        const ids = state.processedWelcomeIds ?? [];
        if (!ids.includes(welcomeId)) {
          ids.push(welcomeId);
          if (ids.length > 200) ids.splice(0, ids.length - 200);
        }
        state.processedWelcomeIds = ids;
      }
      state.updatedAt = Date.now();
      return state;
    });

    if (welcomeId) this.ackWelcome(welcomeId);
    if (newStateB64wfc !== previousStateB64wfc) {
      this.backupSvcRef?.backupGroupState(conversationId, newStateB64wfc);
    }
  }

  // Marks a Welcome consumed on the server with up to 3 retries (backoff: 2s, 4s).
  private ackWelcome(welcomeId: string): void {
    void this.ackWelcomeWithRetry(welcomeId);
  }

  private async ackWelcomeWithRetry(welcomeId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.mlsRepo.ackWelcome(welcomeId);
        return;
      } catch (err) {
        if (attempt < 2) {
          await new Promise<void>(r => setTimeout(r, 2000 * (attempt + 1)));
        } else {
          console.warn('[MLS] ACK permanently failed for Welcome', welcomeId, 'after 3 attempts:', err);
        }
      }
    }
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
  async injectRestoredGroupStates(
    groupStates: Record<string, string>,
    user:        UserProfile,
    device:      SessionDevice,
  ): Promise<void> {
    if (Object.keys(groupStates).length === 0) return;

    const scope = this.makeScope(user.did, device.id);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      let injected = false;
      for (const [convId, gs] of Object.entries(groupStates)) {
        if (!state.groupStates[convId]) {
          state.groupStates[convId] = gs;
          injected = true;
        }
      }
      if (!injected) return null;
      state.updatedAt = Date.now();
      return state;
    });
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
    const pendingIncoming = this.pendingCommits.get(conversationId);
    if (pendingIncoming) await pendingIncoming;

    const scope = this.makeScope(user.did, device.id);

    // Pre-check: abort early if there is nothing to provision (read-only, no lock).
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');
    if (!preState.groupStates[conversationId]) {
      if (!environment.production) console.log('[MLS] provisionDevice: no group state for', conversationId, '— skipping');
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

    // Captured from inside update() for the subsequent HTTP calls.
    let welcomeB64!:          string;
    let commitB64!:           string;
    let newEpoch!:            number;
    let newStateB64pd!:       string;
    let previousStateB64pd:   string | undefined;
    let shouldSkip           = false;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) {
        // Group disappeared while we were fetching the key package.
        shouldSkip = true;
        return null;
      }

      // Guard inside the lock: verify device is not already a member.
      // This prevents the TOCTOU race where two concurrent provisionDevice calls
      // both consumed a KP before entering this lock.
      {
        const members = getGroupMembers(this.restoreClientState(encoded));
        const dec = new TextDecoder();
        const alreadyMember = members.some((m: ReturnType<typeof getGroupMembers>[number]) =>
          m.credential.credentialType === 'basic' &&
          dec.decode(m.credential.identity).endsWith(`#${newDeviceId}`)
        );
        if (alreadyMember) {
          if (!environment.production) console.log('[MLS] provisionDevice: device already member (inside lock), skipping', newDeviceId, conversationId);
          shouldSkip = true;
          return null;
        }
      }

      const clientState = this.restoreClientState(encoded);
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
    const stored = await this.mlsRepo.postCommit(conversationId, commitB64, newEpoch, {
      targetDeviceId: newDeviceId,
      welcome: welcomeB64,
    });

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
        if (previousStateB64pd === undefined) delete s.groupStates[conversationId];
        else s.groupStates[conversationId] = previousStateB64pd;
        s.updatedAt = Date.now();
        return s;
      });
      await this.processIncomingCommit(conversationId, stored.commit, stored.epoch, user, device);
      return;
    }

    if (newStateB64pd !== previousStateB64pd) {
      this.backupSvcRef?.backupGroupState(conversationId, newStateB64pd);
    }
    if (!environment.production) console.log('[MLS] provisionDevice: provisioned', newDeviceId, 'for', conversationId, 'epoch', newEpoch);
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
    const scope = this.makeScope(user.did, device.id);

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      delete state.groupStates[conversationId];
      state.updatedAt = Date.now();
      return state;
    });
  }

  // Applies an incoming MLS public-message Commit to the local group state.
  // Commits for the same conversation are serialized via pendingCommits.
  processIncomingCommit(
    conversationId: string,
    commitBase64:   string,
    epoch:          number,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const existing = this.pendingCommits.get(conversationId) ?? Promise.resolve();

    const next: Promise<void> = existing.then(
      () => this.applyCommit(conversationId, commitBase64, epoch, user, device),
      () => this.applyCommit(conversationId, commitBase64, epoch, user, device),
    );

    // Store a safe (non-rejecting) version in the chain so that a bad commit
    // does not block all subsequent commits for this conversation.
    const safeNext = next.catch(err => {
      console.error('[MLS] processIncomingCommit: epoch', epoch, 'failed for', conversationId, ':', err);
    }) as Promise<void>;

    this.pendingCommits.set(conversationId, safeNext);

    void safeNext.finally(() => {
      if (this.pendingCommits.get(conversationId) === safeNext) {
        this.pendingCommits.delete(conversationId);
      }
    });

    // Return the original (may reject) to callers so they can observe failures.
    return next;
  }

  private async applyCommit(
    conversationId: string,
    commitBase64:   string,
    epoch:          number,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const scope = this.makeScope(user.did, device.id);
    const cs    = await getCiphersuiteImpl(getCiphersuiteFromName(this.cipherSuiteName), defaultCryptoProvider);

    // Decode commit bytes outside the storage lock (pure decoding, no state).
    const commitBytes = this.base64ToBytes(commitBase64);
    const decoded     = decodeMlsMessage(commitBytes, 0)?.[0];
    if (!decoded || decoded.wireformat !== 'mls_public_message') {
      console.error('[MLS] processIncomingCommit: unexpected wireformat for conv', conversationId);
      return;
    }

    let previousStateB64ac: string | undefined;
    let newStateB64ac: string | undefined;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) return null;
      const encoded = state.groupStates[conversationId];
      if (!encoded) return null;

      const clientState  = this.restoreClientState(encoded);
      const currentEpoch = Number(clientState.groupContext.epoch);
      if (currentEpoch >= epoch) return null; // already applied

      try {
        const result = await processPublicMessage(
          clientState,
          decoded.publicMessage,
          emptyPskIndex,
          cs,
          acceptAll,
        );

        previousStateB64ac = state.groupStates[conversationId];
        newStateB64ac      = this.bytesToBase64(encodeGroupState(result.newState));
        state.groupStates[conversationId] = newStateB64ac;
        state.updatedAt = Date.now();
        if (!environment.production) console.log('[MLS] processIncomingCommit: applied epoch', epoch, 'for conv', conversationId);
        return state;
      } catch (err) {
        console.error('[MLS] processIncomingCommit: failed to apply epoch', epoch, 'for conv', conversationId, ':', err);
        throw err;
      }
    });

    if (newStateB64ac && newStateB64ac !== previousStateB64ac) {
      this.backupSvcRef?.backupGroupState(conversationId, newStateB64ac);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private restoreClientState(base64: string): ClientState {
    const bytes   = this.base64ToBytes(base64);
    const decoded = decodeGroupState(bytes, 0);
    if (!decoded) throw new Error('Failed to decode MLS group state');

    const [groupState] = decoded;
    const clientConfig: ClientConfig = {
      keyRetentionConfig:       { ...defaultKeyRetentionConfig, retainKeysForEpochs: 50 },
      lifetimeConfig:           defaultLifetimeConfig,
      keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
      paddingConfig:            defaultPaddingConfig,
      authService:              defaultAuthenticationService,
    };
    return { ...groupState, clientConfig };
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
    return `${userDid}#${deviceId}`;
  }

  private makeScope(userDid: string, deviceId: string): string {
    return `mls:${userDid}:${deviceId}`;
  }

  getStorageScope(userDid: string, deviceId: string): string {
    return this.makeScope(userDid, deviceId);
  }

  private serializePrivatePackage(value: PrivateKeyPackage): SerializedPrivateKeyPackage {
    return {
      initPrivateKey:      this.bytesToBase64(value.initPrivateKey),
      hpkePrivateKey:      this.bytesToBase64(value.hpkePrivateKey),
      signaturePrivateKey: this.bytesToBase64(value.signaturePrivateKey),
    };
  }

  private bytesToBase64(value: Uint8Array): string {
    let binary = '';
    value.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  private base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private async _sha256hex(data: Uint8Array<ArrayBufferLike>): Promise<string> {
    const copy = new Uint8Array(data);
    const buf  = await crypto.subtle.digest('SHA-256', copy);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
      const pendingIncoming = this.pendingCommits.get(convId);
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

      await this.storage.update<StoredMlsState>(scope, async (current) => {
        if (!current || !current.groupStates || !current.groupStates[convId]) return null;

        const encoded = current.groupStates[convId];
        const clientState = this.restoreClientState(encoded);
        const members = getGroupMembers(clientState);
        const dec = new TextDecoder();

        // getGroupMembers() returns leaves in tree order with no attached index —
        // the array position IS the leaf index (see provisionDevice's identical
        // "already member" lookup above, which relies on the same ordering).
        const leafIndex = members.findIndex((m) =>
          m.credential.credentialType === 'basic' &&
          dec.decode(m.credential.identity).endsWith(`#${revokedDeviceId}`)
        );

        if (leafIndex === -1) return null;

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

        const serializedCommit = this.bytesToBase64(encodeMlsMessage(commit));

        let stored;
        try {
          stored = await this.mlsRepo.postCommit(convId, serializedCommit, Number(newState.groupContext.epoch));
        } catch (err) {
          console.error('[MLS] removeRevokedDevice: failed to post Remove commit for conv', convId, err);
          return null;
        }

        // Another device may have posted a commit for the same epoch first (e.g.
        // another recipient of the same device:revoked event racing to remove the
        // same device). Detect it the same way provisionDevice() does: if the
        // stored commit isn't ours, don't write our optimistic state — resync onto
        // the winning commit instead, so we don't fork.
        if (stored.senderDeviceId !== device.id) {
          console.warn(
            '[MLS] removeRevokedDevice: lost commit race for conv', convId,
            '— resyncing on winning commit from', stored.senderDeviceId,
          );
          void this.processIncomingCommit(convId, stored.commit, stored.epoch, user, device)
            .catch(err => console.warn('[MLS] removeRevokedDevice: resync after lost race failed for conv', convId, err));
          return null;
        }

        const serializedState = this.bytesToBase64(encodeGroupState(newState));
        current.groupStates[convId] = serializedState;
        current.updatedAt = Date.now();
        return current;
      });
    }
  }
}
