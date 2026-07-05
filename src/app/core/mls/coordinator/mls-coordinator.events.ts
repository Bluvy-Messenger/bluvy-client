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
