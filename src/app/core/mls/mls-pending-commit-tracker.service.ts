import { Injectable } from '@angular/core';

// Per-conversation serialization queue for incoming Commit processing.
// processIncomingCommit() (MlsCommitService, post-split) chains onto this
// promise and registers the new one synchronously (before any await) so that
// decryptMessage/encryptMessage/the membership-mutation methods can await it
// before entering the storage lock -- eliminating the race between an
// arriving mls:commit event and the next message:new event or provisioning
// attempt. Extracted from MlsService's private `pendingCommits` field so it
// can be shared across the sub-services that split out of MlsService without
// those services needing to inject each other just to reach this one map.
@Injectable({ providedIn: 'root' })
export class MlsPendingCommitTracker {
  private readonly pendingCommits = new Map<string, Promise<void>>();

  // Mirrors Map's own get/set/delete/clear naming exactly (rather than
  // inventing new names) so callers migrating off the original private
  // `pendingCommits: Map<string, Promise<void>>` field are a pure rename,
  // not a semantic remapping.

  // Registers the promise representing "this incoming commit is being
  // applied" for a conversation. Overwrites any previous entry -- there is
  // at most one truly in-flight processIncomingCommit per conversation at a
  // time in practice.
  set(conversationId: string, promise: Promise<void>): void {
    this.pendingCommits.set(conversationId, promise);
  }

  // Returns the in-flight promise for a conversation, if any, so a caller
  // can await it before proceeding (see MlsMembershipService/
  // MlsMessageCryptoService's "wait for pending incoming commit" step).
  get(conversationId: string): Promise<void> | undefined {
    return this.pendingCommits.get(conversationId);
  }

  delete(conversationId: string): void {
    this.pendingCommits.delete(conversationId);
  }

  clear(): void {
    this.pendingCommits.clear();
  }
}
