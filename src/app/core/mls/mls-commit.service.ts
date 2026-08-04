import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import {
  acceptAll,
  decodeMlsMessage,
  emptyPskIndex,
  encodeGroupState,
  processPublicMessage,
} from 'ts-mls';
import type { UserProfile } from '../auth/auth.types';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsRepository } from './mls.repository';
import { EpochGapError } from './errors/epoch-gap-error';
import { MlsCryptoContextService } from './mls-crypto-context.service';
import { MlsBackupRegistry } from './mls-backup-registry.service';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';
import type { SessionDevice, StoredMlsState } from './mls.types';

// Incoming-commit application: processIncomingCommit serializes commits per
// conversation via MlsPendingCommitTracker and delegates the actual crypto
// to applyCommit; catchUpMissedCommits drives that loop for commits missed
// while offline. Extracted from MlsService (Phase 1 Step 2 of the split).
@Injectable({ providedIn: 'root' })
export class MlsCommitService {
  private readonly mlsRepo            = inject(MlsRepository);
  private readonly storage            = inject(MlsStateStorageService);
  private readonly cryptoCtx          = inject(MlsCryptoContextService);
  private readonly backupRegistry     = inject(MlsBackupRegistry);
  private readonly pendingCommitTracker = inject(MlsPendingCommitTracker);

  // Fetches and applies any MLS commits missed while offline.
  // Returns the number of commits actually applied -- the recovery signal
  // consumed by MlsCoordinatorService.recoverFromFailed to distinguish "this
  // device merely missed commits and is now caught up" (a sound basis for
  // healing without a Welcome) from "nothing changed" (0, proves nothing on
  // its own -- a forked device at an epoch >= the server's also gets 0
  // without throwing).
  async catchUpMissedCommits(
    conversationId: string,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<number> {
    const scope = this.cryptoCtx.makeScope(user.did, device.id);

    // Read-only pre-check to get the current epoch for the query parameter.
    const state = await this.storage.load<StoredMlsState>(scope);
    if (!state) return 0;
    const encoded = state.groupStates[conversationId];
    if (!encoded) return 0;

    const clientState  = this.cryptoCtx.restoreClientState(encoded);
    const currentEpoch = Number(clientState.groupContext.epoch);

    const response = await this.mlsRepo.getMissedCommits(conversationId, currentEpoch);

    console.log('[MLS:observability] catchUpMissedCommits', {
      conversationId, localEpoch: currentEpoch, requestedAfterEpoch: currentEpoch, returnedCommits: response.data.length,
    });

    if (response.data.length === 0) return 0;

    if (!environment.production) console.log('[MLS] catchUpMissedCommits: applying', response.data.length, 'missed commit(s) from epoch', currentEpoch, 'for conv', conversationId);
    let appliedCommits = 0;
    for (const item of response.data) {
      try {
        await this.processIncomingCommit(conversationId, item.commit, item.epoch, user, device);
        appliedCommits++;
      } catch (err) {
        console.log('[MLS:observability] catchUpMissedCommits', {
          conversationId, localEpoch: currentEpoch, requestedAfterEpoch: currentEpoch,
          returnedCommits: response.data.length, appliedCommits, result: 'failed', failedAtEpoch: item.epoch,
        });
        throw err;
      }
    }
    console.log('[MLS:observability] catchUpMissedCommits', {
      conversationId, localEpoch: currentEpoch, requestedAfterEpoch: currentEpoch,
      returnedCommits: response.data.length, appliedCommits, result: 'complete',
    });
    return appliedCommits;
  }

  // Applies an incoming MLS public-message Commit to the local group state.
  // Commits for the same conversation are serialized via pendingCommitTracker.
  processIncomingCommit(
    conversationId: string,
    commitBase64:   string,
    epoch:          number,
    user:           UserProfile,
    device:         SessionDevice,
  ): Promise<void> {
    const existing = this.pendingCommitTracker.get(conversationId) ?? Promise.resolve();

    const next: Promise<void> = existing.then(
      () => this.applyCommit(conversationId, commitBase64, epoch, user, device),
      () => this.applyCommit(conversationId, commitBase64, epoch, user, device),
    );

    // Store a safe (non-rejecting) version in the chain so that a bad commit
    // does not block all subsequent commits for this conversation.
    const safeNext = next.catch(err => {
      console.error('[MLS] processIncomingCommit: epoch', epoch, 'failed for', conversationId, ':', err);
    }) as Promise<void>;

    this.pendingCommitTracker.set(conversationId, safeNext);

    void safeNext.finally(() => {
      if (this.pendingCommitTracker.get(conversationId) === safeNext) {
        this.pendingCommitTracker.delete(conversationId);
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
    const scope = this.cryptoCtx.makeScope(user.did, device.id);
    const cs    = await this.cryptoCtx.getCiphersuiteImpl();

    // Decode commit bytes outside the storage lock (pure decoding, no state).
    const commitBytes = this.cryptoCtx.base64ToBytes(commitBase64);
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

      const clientState  = this.cryptoCtx.restoreClientState(encoded);
      const currentEpoch = Number(clientState.groupContext.epoch);
      // Root Cause #1 fix (see AUDIT_02/03): a commit's declared epoch equals the
      // epoch it was built FROM. The legitimate next commit therefore always has
      // epoch === currentEpoch — that case must be applied, not skipped. Only
      // epoch < currentEpoch is genuinely already-applied/stale. Using `>=` here
      // silently discarded every legitimate next commit for any non-committing
      // member, with no error and no log — see AUDIT_02/03 for the full trace.
      if (currentEpoch > epoch) {
        console.log('[MLS:observability] applyCommit', {
          conversationId, deviceId: device.id, currentEpoch, commitEpoch: epoch, result: 'skipped_already_applied',
        });
        return null; // already applied
      }

      // Forensic audit finding F8: epoch > currentEpoch means this device
      // missed one or more commits before this one -- not a fork, just
      // behind. ts-mls's processPublicMessage would reject it with
      // CryptoVerificationError "Could not verify membership" (empirically
      // captured), a message indistinguishable from a genuine crypto/fork
      // failure, so detect the gap here structurally instead of letting it
      // throw and trying to classify the message afterward.
      if (epoch > currentEpoch) {
        console.log('[MLS:observability] applyCommit', {
          conversationId, deviceId: device.id, currentEpoch, commitEpoch: epoch, result: 'epoch_gap',
        });
        throw new EpochGapError(conversationId, currentEpoch, epoch);
      }

      try {
        const result = await processPublicMessage(
          clientState,
          decoded.publicMessage,
          emptyPskIndex,
          cs,
          acceptAll,
        );

        previousStateB64ac = state.groupStates[conversationId];
        newStateB64ac      = this.cryptoCtx.bytesToBase64(encodeGroupState(result.newState));
        state.groupStates[conversationId] = newStateB64ac;
        state.updatedAt = Date.now();
        console.log('[MLS:observability] applyCommit', {
          conversationId, deviceId: device.id, currentEpoch, commitEpoch: epoch, result: 'applied',
        });
        if (!environment.production) console.log('[MLS] processIncomingCommit: applied epoch', epoch, 'for conv', conversationId);
        return state;
      } catch (err) {
        console.log('[MLS:observability] applyCommit', {
          conversationId, deviceId: device.id, currentEpoch, commitEpoch: epoch, result: 'failed', error: err instanceof Error ? err.message : String(err),
        });
        console.error('[MLS] processIncomingCommit: failed to apply epoch', epoch, 'for conv', conversationId, ':', err);
        throw err;
      }
    });

    if (newStateB64ac && newStateB64ac !== previousStateB64ac) {
      this.backupRegistry.backupService?.backupGroupState(conversationId, newStateB64ac);
    }
  }
}
