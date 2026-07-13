export interface EncryptedCacheRecord {
  id:                string;
  // conversationId/createdAt/deletedAt/cacheVersion/encryptionVersion stay in
  // plaintext because IndexedDB/SQLite indexes need to query on them. Every
  // other field (senderDeviceId, senderDid, isMine, ...) lives inside the
  // encrypted blob only — it's already duplicated there, keeping a second
  // plaintext copy on the record gained nothing but exposure.
  conversationId:    string;
  encryptedBlob:     string;
  iv:                string;
  cacheVersion:      number;
  encryptionVersion: number;
  undecryptable:     boolean;
  deletedAt:         number | null;
  createdAt:         number;
  cachedAt:          number;
}

export interface IKeyStore {
  initialize(scope: string): Promise<void>;
  getOrCreateKey(): Promise<CryptoKey>;
  clearKey(): Promise<void>;
}

export interface IMessageStore {
  initialize(): Promise<void>;
  put(record: EncryptedCacheRecord): Promise<void>;
  putMany(records: EncryptedCacheRecord[]): Promise<void>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<EncryptedCacheRecord | null>;
  queryByConversation(conversationId: string, limit: number): Promise<EncryptedCacheRecord[]>;
  queryAllIds(conversationId: string): Promise<string[]>;
  queryNewestId(conversationId: string): Promise<string | null>;
  queryByConversationPaged(
    conversationId: string,
    afterCreatedAt: number,
    limit:          number,
  ): Promise<EncryptedCacheRecord[]>;
  updateDeletedAt(id: string, deletedAt: number): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  clearConversation(conversationId: string): Promise<void>;
}
