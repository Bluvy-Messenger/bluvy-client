export interface SessionDevice {
  id:       string;
  name:     string;
  platform: string;
}

// Semantic result of processing an incoming Welcome. Only 'joined' means
// the local GroupState was actually established/modified by this Welcome --
// 'obsolete' (correctly rejected, epoch guard), 'already-processed'
// (digest guard, idempotent re-delivery) and 'none' (no pending Welcome at
// all) must NEVER be treated as a join by any caller, even though the
// legacy boolean contract collapsed all four into the same "true"/"false".
export type WelcomeProcessingResult = 'joined' | 'obsolete' | 'already-processed' | 'none';

export interface UploadedKeyPackage {
  id:         string;
  deviceId:   string;
  keyPackage: string;
  createdAt:  number;
}

export interface ConsumedKeyPackageResponse {
  keyPackage: string;
  deviceId:   string;
}

export interface SerializedPrivateKeyPackage {
  initPrivateKey:       string;
  hpkePrivateKey:       string;
  signaturePrivateKey:  string;
}

export interface StoredKeyPackageRecord {
  serverId:              string | null;
  deviceId:              string;
  serializedKeyPackage:  string;
  privatePackage:        SerializedPrivateKeyPackage;
  createdAt:             number;
}

export interface PreparedConversationState {
  participantDid:  string;
  remoteDeviceIds: string[];
  preparedAt:      number;
}

// AUDIT P1 crash/restart: what reprovisionLostStateDevice() needs to survive
// a crash between its local optimistic write and postCommit() confirmation.
// previousStateB64 is the confirmed ClientState from immediately BEFORE the
// Remove+Add commit -- the MLS ratchet is one-way, so this is the only way
// to make a post-crash rollback possible; it cannot be reconstructed from
// the (already-written) newState afterward. newEpoch lets a recovery pass
// tell whether the group has already progressed since the crash (see
// recoverPendingReprovisions()) before ever touching previousStateB64.
export interface PendingReprovisionRecord {
  staleDeviceId:    string;
  previousEpoch:    number;
  previousStateB64: string;
  newEpoch:         number;
}

// AUDIT P0 crash/restart: same rationale as PendingReprovisionRecord, applied
// to removeRevokedDeviceFromAllGroups()'s single-Remove write instead of a
// Remove+Add. previousStateB64 is the confirmed ClientState from
// immediately BEFORE the Remove -- the only way to make a post-crash
// rollback possible, since the MLS ratchet cannot be reconstructed
// backward from newStateB64. No leafIndex or commit digest is carried: a
// leaf index would not survive an intervening tree change, and the
// recovery strategy never needs to know a commit's exact content in
// advance -- it always re-derives the true answer from the server via
// catchUpMissedCommits() rather than trusting a locally-cached fact (see
// recoverOnePendingRemoval()'s epoch handling below for why epoch alone is
// treated as a trigger to re-verify, never as proof by itself).
export interface PendingRemovalRecord {
  revokedDeviceId:  string;
  previousEpoch:    number;
  previousStateB64: string;
  newEpoch:         number;
}

// AUDIT P0 crash/restart (ensureGroupReady() genesis, Phase 2 only): same
// rationale as PendingReprovisionRecord/PendingRemovalRecord. previousEpoch
// is always 0 for genesis -- previousStateB64 is the SOLO ClientState
// (creator alone, produced by createGroup(), before any participant is
// added), never undefined here (unlike the mutation methods, genesis
// always has a real "before" state to roll back to: the solo group).
// newEpoch lets recovery tell whether the conversation has already
// progressed since the crash before ever touching previousStateB64 -- but,
// per the design report, epoch equality alone is NEVER trusted as proof;
// it only triggers a real server round trip via catchUpMissedCommits().
export interface PendingGenesisRecord {
  previousEpoch:    number;
  previousStateB64: string;
  newEpoch:         number;
}

export interface StoredMlsState {
  version:            1;
  userDid:            string;
  deviceId:           string;
  deviceName:         string;
  platform:           string;
  cipherSuiteName:    string;
  credentialIdentity: string;
  keyPackages:        StoredKeyPackageRecord[];
  conversations:      Record<string, PreparedConversationState>;
  groupStates:           Record<string, string>;
  /** @deprecated Server row ids are reused across re-provisioning (UPSERT on
   * targetDeviceId+conversationId) -- a genuinely new Welcome can arrive
   * under an id already in this list and be wrongly treated as a re-delivery.
   * Never read this; kept only so already-persisted records still deserialize.
   * Use processedWelcomeDigests instead. */
  processedWelcomeIds?:  string[];
  /** SHA-256 hex of raw Welcome bytes already processed on this device, FIFO-capped at 200. */
  processedWelcomeDigests?: string[];
  /** Highest epoch this device is known to have reached per conversation, even
   * after clearConversationGroup() deletes the live group state -- a tombstone
   * that lets injectRestoredGroupStates() refuse to resurrect a stale backup. */
  lastKnownEpochs?:      Record<string, number>;
  /** In-flight reprovisionLostStateDevice() operations, keyed by conversationId,
   * not yet confirmed as either rolled back or adopted -- see AUDIT P1
   * crash/restart and recoverPendingReprovisions(). Written atomically in the
   * SAME storage.update() as the optimistic Group State write it describes,
   * so it can never exist without a matching write, or vice versa. */
  pendingReprovisions?:  Record<string, PendingReprovisionRecord>;
  /** In-flight removeRevokedDeviceFromAllGroups() operations, keyed by
   * conversationId, not yet confirmed as either rolled back or adopted --
   * see AUDIT P0 crash/restart and recoverPendingRemovals(). Written
   * atomically in the SAME storage.update() as the optimistic Group State
   * write it describes, so it can never exist without a matching write,
   * or vice versa. */
  pendingRemovals?:      Record<string, PendingRemovalRecord>;
  /** In-flight ensureGroupReady() genesis Phase 2 operations (adding the
   * first participants to a just-created solo group), keyed by
   * conversationId, not yet confirmed as either rolled back or adopted --
   * see AUDIT P0 crash/restart (genesis) and recoverPendingGenesises().
   * Written atomically in the SAME storage.update() as the optimistic
   * Group State write it describes. Phase 1 (the solo group itself) needs
   * no marker of its own -- it is unconditionally safe (no network
   * dependency) and is recognized on restart by its member count alone
   * (see ensureGroupReady()'s own pre-check), not a persisted flag. */
  pendingGenesises?:     Record<string, PendingGenesisRecord>;
  initializedAt:         number;
  updatedAt:             number;
}

