export type PermanentMlsErrorKind =
  | 'InvalidCiphertext'
  | 'InvalidSignature'
  | 'CorruptedPayload'
  | 'UnknownSender'
  | 'WireformatMismatch'
  | 'EpochTooOld';

export class PermanentMlsError extends Error {
  override readonly name = 'PermanentMlsError';

  constructor(
    public readonly kind: PermanentMlsErrorKind,
    message: string,
    public readonly conversationId: string,
  ) {
    super(message);
  }
}
