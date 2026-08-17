// Signals that an incoming ciphertext's epoch is AHEAD of this device's
// local epoch -- one or more commits were missed, not a genuine crypto
// failure. Distinct from Transient/PermanentMlsError: ts-mls's real error
// for this case, CryptoError (the browser's raw AEAD failure text, e.g.
// "OperationError: ..."), is indistinguishable by message from a genuine
// crypto/fork failure, so this must be detected structurally (by comparing
// epoch numbers) BEFORE calling processPrivateMessage, not classified after
// the fact from its message. Mirrors errors/epoch-gap-error.ts, which
// solves the identical problem for incoming commits.
export class DecryptEpochAheadError extends Error {
  override readonly name = 'DecryptEpochAheadError';

  constructor(
    public readonly conversationId: string,
    public readonly localEpoch:     number,
    public readonly messageEpoch:   number,
  ) {
    super(`Decrypt epoch ahead for conversation ${conversationId}: local epoch ${localEpoch}, message built at epoch ${messageEpoch} -- one or more commits were missed`);
  }
}
