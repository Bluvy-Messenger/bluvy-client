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
  initializedAt:         number;
  updatedAt:             number;
}

