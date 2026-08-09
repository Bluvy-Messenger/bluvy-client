import { Observable } from 'rxjs';
import type { UserProfile } from '../../auth/auth.types';
import type { DeviceInfo }  from '../../device/device.types';
import type {
  DecryptResult,
  ReplayResult,
  ReplayedDecryptEvent,
} from './mls-coordinator.types';
import type {
  ConversationReadyEvent,
  WelcomeProcessedEvent,
  CommitAppliedEvent,
  ConversationFailedEvent,
  PendingDecryptQueuedEvent,
  RestoreCompletedEvent,
  HistoryRecoveryCompletedEvent,
} from './mls-coordinator.events';

// Abstract base class used as the Angular DI token for MlsCoordinatorService.
// Components and services must inject MlsCoordinatorBase — never MlsCoordinatorService directly.
//
// This class intentionally does NOT expose:
//   - getConversationState()   (internal enum, use semantic methods below)
//   - hasGroupState()          (implementation detail, use canProvision())
//   - setBackupService()       (lifecycle concern, not a consumer API)
//   - ConversationMlsState     (internal type)
export abstract class MlsCoordinatorBase {
  // ── Session ───────────────────────────────────────────────────────────────
  abstract initializeForSession(user: UserProfile, device: DeviceInfo): Promise<void>;

  // ── Semantic capability checks ────────────────────────────────────────────
  // Synchronous checks based on in-memory state only.
  abstract isConversationReady(convId: string): boolean;
  // True only when this conversation has explicitly transitioned to FAILED --
  // NOT simply "not yet ready". A conversation that has never been touched by
  // ensureGroupReady() (e.g. freshly created, or freshly recreated -- see
  // AUDIT_02/04/05 Root Cause #3 fallback) is neither ready nor failed; it
  // will establish transparently on first send. Conflating "not ready yet"
  // with "broken" here previously caused a brand-new/recreated conversation
  // to show the same "restore encryption" affordance as a genuinely broken one.
  abstract isConversationFailed(convId: string): boolean;
  abstract canEncrypt(convId: string): boolean;
  abstract canDecrypt(convId: string): boolean;
  // Async: reads IndexedDB for conversations not yet in memory.
  abstract canProvision(convId: string, user: UserProfile, device: DeviceInfo): Promise<boolean>;

  // ── Welcome ───────────────────────────────────────────────────────────────
  abstract processWelcome(
    welcomeId:     string | null,
    welcomeBase64: string,
    convId:        string,
    user:          UserProfile,
    device:        DeviceInfo,
  ): Promise<void>;

  abstract fetchAndProcessPendingWelcome(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<boolean>;

  // ── Group ─────────────────────────────────────────────────────────────────
  abstract ensureGroupReady(
    convId:         string,
    participantDid: string,
    user:           UserProfile,
    device:         DeviceInfo,
    signal?:        AbortSignal,
    preConsumedKeyPackage?: { keyPackage: string; deviceId: string },
    memberDids?:    string[],
  ): Promise<void>;

  abstract clearConversationGroup(convId: string, user: UserProfile, device: DeviceInfo): Promise<void>;

  // Pre-fetch key packages for a participant before opening a conversation.
  abstract prepareConversation(user: UserProfile, device: DeviceInfo, participantDid: string): Promise<void>;

  abstract prepareConversationWithKeyPackage(
    user:           UserProfile,
    device:         DeviceInfo,
    participantDid: string,
    convId:         string,
    keyPackage:     { keyPackage: string; deviceId: string }
  ): Promise<void>;

  // ── Messaging ─────────────────────────────────────────────────────────────
  // Never throws — always returns a DecryptResult with state: plaintext | pending_decrypt | undecryptable.
  abstract decryptMessage(
    convId:         string,
    messageId:      string,
    senderDid:      string,
    senderDeviceId: string,
    isMine:         boolean,
    createdAt:      number,
    ciphertextB64:  string,
    user:           UserProfile,
    device:         DeviceInfo,
  ): Promise<DecryptResult>;

  abstract encryptMessage(
    convId:    string,
    plaintext: string,
    user:      UserProfile,
    device:    DeviceInfo,
  ): Promise<string>;

  // ── Commits ───────────────────────────────────────────────────────────────
  abstract processIncomingCommit(
    convId:       string,
    commitBase64: string,
    epoch:        number,
    user:         UserProfile,
    device:       DeviceInfo,
  ): Promise<void>;

  abstract catchUpMissedCommits(convId: string, user: UserProfile, device: DeviceInfo): Promise<void>;

  // ── Provisioning ──────────────────────────────────────────────────────────
  abstract provisionDevice(
    newDeviceId: string,
    convId:      string,
    user:        UserProfile,
    device:      DeviceInfo,
  ): Promise<void>;

  abstract removeRevokedDeviceFromAllGroups(
    revokedDeviceId: string,
    user:            UserProfile,
    device:          DeviceInfo,
  ): Promise<void>;

  // Re-provisions a device that already has a leaf in the MLS tree but lost
  // its local state (see Phase 8b / AUDIT_02 Root Cause #3). Unlike
  // provisionDevice(), which no-ops when the target is already a member,
  // this removes the stale leaf and re-adds it in the same commit so a fresh
  // Welcome is produced.
  abstract reprovisionLostStateDevice(
    staleDeviceId: string,
    convId:        string,
    user:          UserProfile,
    device:        DeviceInfo,
  ): Promise<void>;

  // ── Restore ───────────────────────────────────────────────────────────────
  abstract injectRestoredGroupStates(
    groupStates: Record<string, string>,
    user:        UserProfile,
    device:      DeviceInfo,
  ): Promise<void>;

  // ── Replay ────────────────────────────────────────────────────────────────
  abstract replayPendingDecrypts(convId: string, user: UserProfile, device: DeviceInfo): Promise<ReplayResult>;

  // Re-checks messages currently stored as undecryptable placeholders for
  // convId against the cloud backup, in case the MBK wasn't unlocked yet at
  // the time they were marked undecryptable (see clearConversationGroup's
  // recoverMissingHistoryBeforeClear). Returns how many were actually
  // recovered by this call -- 0 if the MBK still isn't available, or if
  // there was nothing to retry.
  abstract retryUndecryptableViaCloudBackup(convId: string, user: UserProfile, device: DeviceInfo): Promise<number>;

  // ── Domain events (Observable only — never Subject) ───────────────────────
  abstract readonly conversationReady$:          Observable<ConversationReadyEvent>;
  abstract readonly welcomeProcessed$:           Observable<WelcomeProcessedEvent>;
  abstract readonly commitApplied$:              Observable<CommitAppliedEvent>;
  abstract readonly conversationFailed$:         Observable<ConversationFailedEvent>;
  abstract readonly pendingDecryptQueued$:       Observable<PendingDecryptQueuedEvent>;
  abstract readonly pendingDecryptReplayed$:     Observable<ReplayedDecryptEvent>;
  abstract readonly restoreCompleted$:           Observable<RestoreCompletedEvent>;
  abstract readonly historyRecoveryCompleted$:   Observable<HistoryRecoveryCompletedEvent>;

  abstract clear(): void;
}
