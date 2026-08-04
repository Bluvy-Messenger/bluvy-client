import { Injectable } from '@angular/core';

// Combines what used to be two separate structurally-typed interfaces --
// MlsService's BackupServiceLike (backupGroupState only) and
// MlsCoordinatorService's BackupEnqueuerLike (enqueue/isMbkAvailable/restore)
// -- into the single reference every MLS sub-service reads from. SyncService
// implements the full shape and registers itself once; any consumer here
// only calls the subset of methods it actually needs (structural typing
// makes a wider registered object safely usable wherever a narrower shape
// would have been expected).
//
// SyncService can't be injected directly by MLS services -- it already
// injects the MLS coordinator (for injectRestoredGroupStates), so the
// reverse dependency would be circular. This registered-reference pattern
// (setBackupService, called once from SyncService's constructor) avoids
// that entirely.
export interface MlsBackupServiceRef {
  backupGroupState(conversationId: string, stateB64: string): void;
  enqueue(item: {
    messageId:      string;
    conversationId: string;
    plaintext:      string;
    createdAt:      number;
    senderDid:      string;
  }): void;
  isMbkAvailable(): boolean;
  restore(): Promise<unknown>;
}

@Injectable({ providedIn: 'root' })
export class MlsBackupRegistry {
  private ref: MlsBackupServiceRef | null = null;

  setBackupService(svc: MlsBackupServiceRef): void {
    this.ref = svc;
  }

  get backupService(): MlsBackupServiceRef | null {
    return this.ref;
  }
}
