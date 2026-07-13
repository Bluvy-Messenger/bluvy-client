import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { EncryptedCacheRecord, IMessageStore } from './message-cache.types';

const DB_NAME    = 'skychat-cache';
const DB_VERSION = 3;

const SCHEMA_V1: string[] = [
  `CREATE TABLE IF NOT EXISTS message_cache (
    id                 TEXT    PRIMARY KEY,
    conversation_id    TEXT    NOT NULL,
    sender_device_id   TEXT    NOT NULL,
    encrypted_blob     TEXT    NOT NULL,
    iv                 TEXT    NOT NULL,
    cache_version      INTEGER NOT NULL DEFAULT 1,
    encryption_version INTEGER NOT NULL DEFAULT 1,
    is_mine            INTEGER NOT NULL DEFAULT 0,
    undecryptable      INTEGER NOT NULL DEFAULT 0,
    deleted_at         INTEGER,
    created_at         INTEGER NOT NULL,
    cached_at          INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS mc_conv_created
     ON message_cache(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS mc_conv_id
     ON message_cache(conversation_id, id)`,
];

const SCHEMA_V2: string[] = [
  `ALTER TABLE message_cache ADD COLUMN sender_did TEXT`,
];

const INSERT_SQL = `
  INSERT OR REPLACE INTO message_cache
    (id, conversation_id, sender_device_id, sender_did, encrypted_blob, iv,
     cache_version, encryption_version, is_mine, undecryptable,
     deleted_at, created_at, cached_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class NativeMessageStore implements IMessageStore {
  private sqlite: SQLiteConnection;
  private db: SQLiteDBConnection | null = null;

  constructor() {
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  async initialize(): Promise<void> {
    await this.sqlite.addUpgradeStatement(DB_NAME, [
      { toVersion: 1, statements: SCHEMA_V1 },
      { toVersion: 2, statements: SCHEMA_V2 },
      { toVersion: 3, statements: [] },
    ]);
    
    const isConn = await this.sqlite.isConnection(DB_NAME, false);
    if (isConn.result) {
      this.db = await this.sqlite.retrieveConnection(DB_NAME, false);
    } else {
      this.db = await this.sqlite.createConnection(
        DB_NAME,
        false,
        'no-encryption',
        DB_VERSION,
        false,
      );
    }
    
    const isOpen = await this.db.isDBOpen();
    if (!isOpen.result) {
      await this.db.open();
    }
  }

  async put(record: EncryptedCacheRecord): Promise<void> {
    await this.db!.run(INSERT_SQL, this.toValues(record));
  }

  async putMany(records: EncryptedCacheRecord[]): Promise<void> {
    if (records.length === 0) return;
    const set = records.map(r => ({ statement: INSERT_SQL, values: this.toValues(r) }));
    // transaction: true → plugin wraps the full set in BEGIN / COMMIT
    await this.db!.executeSet(set, true);
  }

  async has(id: string): Promise<boolean> {
    const result = await this.db!.query(
      'SELECT COUNT(*) AS cnt FROM message_cache WHERE id = ?',
      [id],
    );
    return ((result.values?.[0]?.cnt as number | undefined) ?? 0) > 0;
  }

  async get(id: string): Promise<EncryptedCacheRecord | null> {
    const result = await this.db!.query(
      'SELECT * FROM message_cache WHERE id = ?',
      [id],
    );
    const row = result.values?.[0];
    return row ? this.rowToRecord(row) : null;
  }

  async queryByConversation(conversationId: string, limit: number): Promise<EncryptedCacheRecord[]> {
    // Fetch newest `limit` in DESC, then reverse to get ASC for display.
    const result = await this.db!.query(
      `SELECT * FROM message_cache
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [conversationId, limit],
    );
    return ((result.values ?? []) as Record<string, unknown>[])
      .map(r => this.rowToRecord(r))
      .reverse();
  }

  async queryAllIds(conversationId: string): Promise<string[]> {
    const result = await this.db!.query(
      'SELECT id FROM message_cache WHERE conversation_id = ?',
      [conversationId],
    );
    return ((result.values ?? []) as Record<string, unknown>[])
      .map(r => r['id'] as string);
  }

  async queryByConversationPaged(
    conversationId: string,
    afterCreatedAt: number,
    limit: number,
  ): Promise<EncryptedCacheRecord[]> {
    const result = await this.db!.query(
      `SELECT * FROM message_cache
       WHERE conversation_id = ? AND created_at > ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [conversationId, afterCreatedAt, limit],
    );
    return ((result.values ?? []) as Record<string, unknown>[])
      .map(r => this.rowToRecord(r));
  }

  async queryNewestId(conversationId: string): Promise<string | null> {
    const result = await this.db!.query(
      `SELECT id FROM message_cache
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [conversationId],
    );
    return (result.values?.[0]?.['id'] as string | undefined) ?? null;
  }

  async updateDeletedAt(id: string, deletedAt: number): Promise<void> {
    await this.db!.run(
      'UPDATE message_cache SET deleted_at = ? WHERE id = ?',
      [deletedAt, id],
    );
  }

  async updateSenderDid(id: string, senderDid: string, isMine: boolean): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    if (current.senderDid === senderDid) return false;
    await this.db!.run(
      'UPDATE message_cache SET sender_did = ?, is_mine = ? WHERE id = ?',
      [senderDid, isMine ? 1 : 0, id],
    );
    return true;
  }

  async delete(id: string): Promise<void> {
    await this.db!.run(
      'DELETE FROM message_cache WHERE id = ?',
      [id],
    );
  }

  async clear(): Promise<void> {
    await this.db!.execute('DELETE FROM message_cache', false);
  }

  async clearConversation(conversationId: string): Promise<void> {
    await this.db!.run(
      'DELETE FROM message_cache WHERE conversation_id = ?',
      [conversationId],
    );
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private toValues(r: EncryptedCacheRecord): unknown[] {
    return [
      r.id, r.conversationId, r.senderDeviceId,
      r.senderDid ?? null,
      r.encryptedBlob, r.iv,
      r.cacheVersion, r.encryptionVersion,
      r.isMine ? 1 : 0, r.undecryptable ? 1 : 0,
      r.deletedAt,
      r.createdAt, r.cachedAt,
    ];
  }

  private rowToRecord(row: Record<string, unknown>): EncryptedCacheRecord {
    return {
      id:                row['id'] as string,
      conversationId:    row['conversation_id'] as string,
      senderDeviceId:    row['sender_device_id'] as string,
      senderDid:         (row['sender_did'] as string | null | undefined) ?? undefined,
      encryptedBlob:     row['encrypted_blob'] as string,
      iv:                row['iv'] as string,
      cacheVersion:      row['cache_version'] as number,
      encryptionVersion: row['encryption_version'] as number,
      isMine:            row['is_mine'] === 1,
      undecryptable:     row['undecryptable'] === 1,
      deletedAt:         (row['deleted_at'] as number | null | undefined) ?? null,
      createdAt:         row['created_at'] as number,
      cachedAt:          row['cached_at'] as number,
    };
  }
}
