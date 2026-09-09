export type TransientMlsErrorKind =
  | 'GroupNotReady'
  | 'InitializationPending'
  | 'CommitPending'
  | 'EpochMismatch'
  // An epoch/ratchet or raw-crypto failure seen BEFORE this device confirmed
  // it is caught up: mid-catch-up it is an expected intermediate state, not a
  // fork. Becomes permanent once caughtUpConvs proves we're current.
  | 'NotCaughtUp';

export class TransientMlsError extends Error {
  override readonly name = 'TransientMlsError';

  constructor(
    public readonly kind: TransientMlsErrorKind,
    message: string,
    public readonly conversationId: string,
  ) {
    super(message);
  }
}
