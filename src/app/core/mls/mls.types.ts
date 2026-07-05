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
  processedWelcomeIds?:  string[];
  initializedAt:         number;
  updatedAt:             number;
}

