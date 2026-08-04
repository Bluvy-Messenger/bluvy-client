import { Injectable, inject } from '@angular/core';
import {
  acceptAll,
  createApplicationMessage,
  decodeMlsMessage,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  processPrivateMessage,
} from 'ts-mls';
import type { UserProfile } from '../auth/auth.types';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsCryptoContextService } from './mls-crypto-context.service';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';
import type { SessionDevice, StoredMlsState } from './mls.types';

// Raw per-message MLS crypto: encryptMessage/decryptMessage. Extracted from
// MlsService (Phase 1 Step 4 of the split). This is deliberately just the
// crypto operation -- the coordinator's dedup/state-tracking wrapper around
// decryptMessage (inFlightDecrypts, conversation state transitions) stays in
// MlsCoordinatorService, since it orchestrates across sub-services that
// don't exist yet at this point in the split (Phase 2).
@Injectable({ providedIn: 'root' })
export class MlsMessageCryptoService {
  private readonly storage            = inject(MlsStateStorageService);
  private readonly cryptoCtx          = inject(MlsCryptoContextService);
  private readonly pendingCommitTracker = inject(MlsPendingCommitTracker);

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

    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const cs    = await this.cryptoCtx.getCiphersuiteImpl();

    let ciphertextB64!: string;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) throw new Error('MLS group not ready for this conversation');

      const clientState = this.cryptoCtx.restoreClientState(encoded);
      const { newState, privateMessage } = await createApplicationMessage(
        clientState,
        new TextEncoder().encode(text),
        cs,
      );

      ciphertextB64 = this.cryptoCtx.bytesToBase64(encodeMlsMessage({
        version:        'mls10',
        wireformat:     'mls_private_message',
        privateMessage,
      }));

      state.groupStates[conversationId] = this.cryptoCtx.bytesToBase64(encodeGroupState(newState));
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

    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const cs    = await this.cryptoCtx.getCiphersuiteImpl();

    // Decode message bytes outside lock (no state dependency).
    const msgBytes = this.cryptoCtx.base64ToBytes(ciphertextBase64);
    const decoded  = decodeMlsMessage(msgBytes, 0)?.[0];
    if (!decoded || decoded.wireformat !== 'mls_private_message') {
      throw new Error('Invalid MLS message');
    }

    let plaintext!: string;

    await this.storage.update<StoredMlsState>(scope, async (state) => {
      if (!state) throw new Error('MLS not initialized');
      const encoded = state.groupStates[conversationId];
      if (!encoded) throw new Error('MLS group not ready for this conversation');

      const clientState = this.cryptoCtx.restoreClientState(encoded);
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
      state.groupStates[conversationId] = this.cryptoCtx.bytesToBase64(encodeGroupState(result.newState));
      state.updatedAt = Date.now();
      return state;
    });

    return plaintext;
  }
}
