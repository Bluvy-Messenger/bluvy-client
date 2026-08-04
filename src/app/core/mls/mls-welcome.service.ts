import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import {
  decodeMlsMessage,
  emptyPskIndex,
  encodeGroupState,
  joinGroup,
  type PrivateKeyPackage,
} from 'ts-mls';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import type { UserProfile } from '../auth/auth.types';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsRepository } from './mls.repository';
import { MlsCryptoContextService } from './mls-crypto-context.service';
import { MlsBackupRegistry } from './mls-backup-registry.service';
import type { SessionDevice, StoredMlsState } from './mls.types';

// Welcome ingestion: fetching pending Welcomes, joining the corresponding MLS
// group, and acking consumed Welcomes on the server. Extracted from
// MlsService (Phase 1 Step 1 of the mls.service.ts split).
@Injectable({ providedIn: 'root' })
export class MlsWelcomeService {
  private readonly mlsRepo        = inject(MlsRepository);
  private readonly storage        = inject(MlsStateStorageService);
  private readonly cryptoCtx      = inject(MlsCryptoContextService);
  private readonly backupRegistry = inject(MlsBackupRegistry);

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

  // Processes an incoming Welcome and joins the corresponding MLS group.
  // The joinGroup crypto runs outside the storage lock; the state write is atomic.
  async processWelcomeForConversation(
    welcomeId:      string | null,
    welcomeBase64:  string,
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const scope = this.cryptoCtx.makeScope(user.did, device.id);

    // Parse the Welcome outside the lock (no state dependency).
    const welcomeBytes   = this.cryptoCtx.base64ToBytes(welcomeBase64);
    const welcomeMessage = decodeMlsMessage(welcomeBytes, 0)?.[0];
    if (!welcomeMessage || welcomeMessage.wireformat !== 'mls_welcome') {
      throw new Error('Invalid Welcome message');
    }

    const cs = await this.cryptoCtx.getCiphersuiteImpl();

    // Pre-read to get the key package list for Welcome matching.
    const preState = await this.storage.load<StoredMlsState>(scope);
    if (!preState) throw new Error('MLS not initialized');

    // Idempotence: keyed by content digest, not the server row id -- the
    // backend UPSERTs a device's pending Welcome row on (targetDeviceId,
    // conversationId) when re-provisioning (mls.schema.ts's
    // device_welcomes_target_conv_unique), so a genuinely NEW Welcome can
    // arrive under an id already seen. Treating the id as identity silently
    // discarded and falsely ACKed that new Welcome, leaving the device
    // stuck on a stale group state. The digest only answers "have I seen
    // these exact bytes before" -- it never substitutes for joinGroup()'s
    // cryptographic verification below.
    const welcomeDigest = await this.cryptoCtx.sha256hex(welcomeBytes);
    if (preState.processedWelcomeDigests?.includes(welcomeDigest)) {
      if (!environment.production) console.log('[MLS] processWelcomeForConversation: Welcome already processed, ACKing:', welcomeId);
      if (welcomeId) this.ackWelcome(welcomeId);
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
        const kpBytes   = this.cryptoCtx.base64ToBytes(kpRecord.serializedKeyPackage);
        const kpDecoded = decodeMlsMessage(kpBytes, 0)?.[0];
        if (!kpDecoded || kpDecoded.wireformat !== 'mls_key_package') {
          kpIndex++; continue;
        }

        const _kpRef8     = _toHex(await makeKeyPackageRef(kpDecoded.keyPackage, cs.hash));
        const _kpB64fp    = kpRecord.serializedKeyPackage.substring(0, 48);
        const _kpSha256_8 = await this.cryptoCtx.sha256hex(kpBytes);
        const _match8     = _welcomeRefs.some(r => r === _kpRef8);
        if (!environment.production) console.log(`[MLS:trace:8]   KP index=${kpIndex}  sha256=${_kpSha256_8}  computedRef=${_kpRef8}  b64fp=${_kpB64fp}  matches=${_match8 ? 'YES ←' : 'no'}`);

        const privateKeys: PrivateKeyPackage = {
          initPrivateKey:      this.cryptoCtx.base64ToBytes(kpRecord.privatePackage.initPrivateKey),
          hpkePrivateKey:      this.cryptoCtx.base64ToBytes(kpRecord.privatePackage.hpkePrivateKey),
          signaturePrivateKey: this.cryptoCtx.base64ToBytes(kpRecord.privatePackage.signaturePrivateKey),
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
      // Do NOT ACK here (forensic audit finding F7): this row is the only
      // copy of this device's group secrets. A transient cause (KP pool not
      // yet refilled, a device-identity scope mismatch) must not be turned
      // into a permanent loss by destroying the row server-side before we've
      // actually joined. Leaving it pending lets the existing durable-retry
      // design (see ackWelcomeWithRetry's rationale below) re-serve it on the
      // next getPendingWelcomes poll instead.
      throw new Error(`No matching key package found for Welcome (tried ${preState.keyPackages.length})`);
    }

    // ── Atomic state write ────────────────────────────────────────────────────

    const newStateB64wfc      = this.cryptoCtx.bytesToBase64(encodeGroupState(joinedGroupState));
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
      // Record processed Welcome digest for idempotent re-delivery handling (max 200, FIFO).
      const digests = state.processedWelcomeDigests ?? [];
      if (!digests.includes(welcomeDigest)) {
        digests.push(welcomeDigest);
        if (digests.length > 200) digests.splice(0, digests.length - 200);
      }
      state.processedWelcomeDigests = digests;
      state.updatedAt = Date.now();
      return state;
    });

    if (welcomeId) this.ackWelcome(welcomeId);
    if (newStateB64wfc !== previousStateB64wfc) {
      this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64wfc);
    }
  }

  // Marks a Welcome consumed on the server with up to 5 retries (backoff: 1s, 2s, 4s, 8s).
  //
  // Durability invariant: a permanently-failed ACK here is not a dead end.
  // The row stays "pending" server-side, so the next getPendingWelcomes
  // fetch (every conversation open, every ensureGroupReady() call) re-serves
  // it, and processWelcomeForConversation()'s content-digest guard above
  // recognizes it as already-processed and re-ACKs it. That opportunistic
  // refetch IS the durable retry -- do not add a separate pending-ack store,
  // it would just duplicate this existing mechanism with a second source of truth.
  private ackWelcome(welcomeId: string): void {
    void this.ackWelcomeWithRetry(welcomeId);
  }

  private async ackWelcomeWithRetry(welcomeId: string): Promise<void> {
    const delaysMs = [1000, 2000, 4000, 8000];
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        await this.mlsRepo.ackWelcome(welcomeId);
        return;
      } catch (err) {
        if (attempt < delaysMs.length) {
          await new Promise<void>(r => setTimeout(r, delaysMs[attempt]));
        } else {
          console.warn('[MLS] ACK failed for Welcome', welcomeId, `after ${delaysMs.length + 1} attempts (will retry opportunistically on next pending-Welcome fetch):`, err);
        }
      }
    }
  }
}
