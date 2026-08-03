// Signals that an incoming commit's declared (pre-commit) epoch is AHEAD of
// this device's local epoch -- one or more commits were missed, not applied
// out of order or already-applied. Distinct from Transient/PermanentMlsError:
// ts-mls's real error for this case (empirically captured, see forensic audit
// finding F8), CryptoVerificationError "Could not verify membership", is
// indistinguishable by message from a genuine crypto/fork failure, so this
// must be detected structurally (by comparing epoch numbers) BEFORE calling
// processPublicMessage, not classified after the fact from its message.
export class EpochGapError extends Error {
  override readonly name = 'EpochGapError';

  constructor(
    public readonly conversationId: string,
    public readonly currentEpoch:   number,
    public readonly commitEpoch:    number,
  ) {
    super(`Epoch gap for conversation ${conversationId}: local epoch ${currentEpoch}, incoming commit built from epoch ${commitEpoch} -- one or more commits were missed`);
  }
}
