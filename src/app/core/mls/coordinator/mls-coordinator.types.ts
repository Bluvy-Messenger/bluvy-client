import type { CachedMessage } from '../../conversation/conversation.types';
import type { TransientMlsErrorKind } from '../errors/transient-mls-error';
import type { PermanentMlsErrorKind }  from '../errors/permanent-mls-error';

export enum ConversationMlsState {
  Empty          = 'EMPTY',
  Joining        = 'JOINING',
  Initializing   = 'INITIALIZING',
  Ready          = 'READY',
  ApplyingCommit = 'APPLYING_COMMIT',
  Failed         = 'FAILED',
}

export type MessageDecryptState = 'pending_decrypt' | 'plaintext' | 'undecryptable';

export interface DecryptResult {
  readonly messageId:      string;
  readonly conversationId: string;
  readonly state:          MessageDecryptState;
  readonly plaintext:      string;
  readonly errorKind?:     PermanentMlsErrorKind | TransientMlsErrorKind;
  readonly operationId:    string;
}

export interface ReplayResult {
  readonly conversationId:  string;
  readonly total:           number;
  readonly succeeded:       number;
  readonly permanentFailed: number;
  readonly stillPending:    number;
  readonly operationId:     string;
}

export interface ReplayedDecryptEvent {
  readonly conversationId: string;
  readonly messages:       CachedMessage[];
}
