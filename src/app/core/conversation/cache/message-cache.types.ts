export interface EncryptedCacheRecord {
  id:                string;
  conversationId:    string;
  senderDeviceId:    string;
  senderDid?:        string;   // plain field — set for new records; used by updateSenderDid()
  encryptedBlob:     string;
  iv:                string;
  cacheVersion:      number;
  encryptionVersion: number;
  isMine:            boolean;
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
  // Updates senderDid and isMine on the plain record without re-encrypting the blob.
  // Returns true if the record was found and the value actually changed.
  updateSenderDid(id: string, senderDid: string, isMine: boolean): Promise<boolean>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}
