export type TransientMlsErrorKind =
  | 'GroupNotReady'
  | 'InitializationPending'
  | 'CommitPending'
  | 'EpochMismatch';

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
