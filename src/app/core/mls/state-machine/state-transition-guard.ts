import { ConversationMlsState } from '../coordinator/mls-coordinator.types';
import { MlsAssertionError }     from '../assertions/mls-assertions';

// Reason token that bypasses transition validation for restore operations.
// injectRestoredGroupStates() writes EMPTY → READY directly from backup data.
export const TRANSITION_REASON_RESTORE = 'restore' as const;
export type TransitionReason = typeof TRANSITION_REASON_RESTORE | undefined;

const ALLOWED = new Map<ConversationMlsState, ReadonlySet<ConversationMlsState>>([
  [
    ConversationMlsState.Empty,
    new Set([ConversationMlsState.Joining, ConversationMlsState.Initializing, ConversationMlsState.Failed]),
  ],
  [
    ConversationMlsState.Joining,
    new Set([ConversationMlsState.Ready, ConversationMlsState.Failed]),
  ],
  [
    ConversationMlsState.Initializing,
    new Set([ConversationMlsState.Ready, ConversationMlsState.Joining, ConversationMlsState.Failed]),
  ],
  [
    ConversationMlsState.Ready,
    new Set([ConversationMlsState.ApplyingCommit, ConversationMlsState.Joining, ConversationMlsState.Empty]),
  ],
  [
    ConversationMlsState.ApplyingCommit,
    new Set([ConversationMlsState.Ready, ConversationMlsState.Failed]),
  ],
  [
    ConversationMlsState.Failed,
    new Set([ConversationMlsState.Empty]),
  ],
]);

// Pure class — no Angular DI, no side effects.
// Used exclusively by MlsCoordinatorService.transitionState().
export class MlsStateTransitionGuard {
  static validate(
    from:   ConversationMlsState,
    to:     ConversationMlsState,
    convId: string,
    reason: TransitionReason = undefined,
  ): void {
    // Restore path bypasses normal transition rules.
    if (reason === TRANSITION_REASON_RESTORE) return;

    const allowed = ALLOWED.get(from);
    if (!allowed?.has(to)) {
      const permitted = allowed ? [...allowed].join(', ') : 'none';
      throw new MlsAssertionError(
        `Forbidden MLS transition: ${from} → ${to} for convId=${convId}`,
        `${from} → ${to}`,
        `${from} → one of [${permitted}]`,
      );
    }
  }
}
