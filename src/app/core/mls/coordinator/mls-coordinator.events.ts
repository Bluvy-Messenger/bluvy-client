import type { ConversationMlsState } from './mls-coordinator.types';
import type { TransientMlsErrorKind } from '../errors/transient-mls-error';

export interface ConversationReadyEvent {
  readonly conversationId: string;
  readonly from:           ConversationMlsState;
  readonly operationId:    string;
}

export interface WelcomeProcessedEvent {
  readonly conversationId: string;
  readonly welcomeId:      string | null;
  readonly operationId:    string;
}

export interface CommitAppliedEvent {
  readonly conversationId: string;
  readonly epoch:          number;
  readonly operationId:    string;
}

// Emitted when a conversation transitions to FAILED after MAX_COMMIT_FAILURES
// consecutive commit-application failures (e.g. a commit race fork — see
// provisionDevice). Consumed by conversation pages to surface the existing
// "reestablish encryption" button.
export interface ConversationFailedEvent {
  readonly conversationId: string;
}

export interface PendingDecryptQueuedEvent {
  readonly conversationId: string;
  readonly messageId:      string;
  readonly errorKind:      TransientMlsErrorKind;
  readonly operationId:    string;
}

export interface RestoreCompletedEvent {
  readonly conversationCount: number;
  readonly operationId:       string;
}

// Emitted after recoverMissingHistoryBeforeClear() completes a confirmed-
// complete sweep (cloud backup + MLS decrypt) right before a conversation's
// group state is destroyed (recreate fallback, or recoverFromFailed's
// automatic reset). stillUndecryptable > 0 means some messages could not be
// recovered by any means and are now permanently "[Encrypted]" placeholders.
export interface HistoryRecoveryCompletedEvent {
  readonly conversationId:     string;
  readonly recovered:          number;
  readonly stillUndecryptable: number;
}
