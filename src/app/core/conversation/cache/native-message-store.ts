import { Preferences } from '@capacitor/preferences';
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { EncryptedCacheRecord, IMessageStore } from './message-cache.types';

const DB_VERSION = 4;

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

// v2 -> v3 had no real schema change historically, but the native plugin
// throws "onUpgrade statement not given" for any toVersion step whose
// statements array is empty (UtilsUpgrade.java) — even for devices that
// never actually need this step (curVersion >= 3 skips it entirely; only
// devices still below version 3 hit it). Re-running an existing IF NOT
// EXISTS index is a genuine no-op that satisfies the plugin's requirement.
const SCHEMA_V3: string[] = [
  `CREATE INDEX IF NOT EXISTS mc_conv_created ON message_cache(conversation_id, created_at)`,
];

// sender_device_id/sender_did/is_mine used to be duplicated in plaintext —
// they're already inside encrypted_blob, so drop the plaintext columns.
const SCHEMA_V4: string[] = [
  `ALTER TABLE message_cache DROP COLUMN sender_device_id`,
  `ALTER TABLE message_cache DROP COLUMN sender_did`,
  `ALTER TABLE message_cache DROP COLUMN is_mine`,
];

const INSERT_SQL = `
  INSERT OR REPLACE INTO message_cache
    (id, conversation_id, encrypted_blob, iv,
     cache_version, encryption_version, undecryptable,
     deleted_at, created_at, cached_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class NativeMessageStore implements IMessageStore {
  private sqlite: SQLiteConnection;
  private db: SQLiteDBConnection | null = null;
  private dbName = 'skychat-cache';
  private sanitizedDid = '';

  constructor(sanitizedDid: string) {
    this.sanitizedDid = sanitizedDid;
    this.dbName = `skychat-cache-${sanitizedDid}`;
    this.sqlite = new SQLiteConnection(CapacitorSQLite);
  }

  async initialize(): Promise<void> {
    const migrationKey = `migration.cache.${this.sanitizedDid}`;
    const { value: migrated } = await Preferences.get({ key: migrationKey });
    if (!migrated) {
      try {
        await this.migrateLegacyDb();
      } catch (err) {
        console.error('[NativeMessageStore] Migration failed:', err);
      }
      await Preferences.set({ key: migrationKey, value: 'true' });
    }

    await this.sqlite.addUpgradeStatement(this.dbName, [
      { toVersion: 1, statements: SCHEMA_V1 },
      { toVersion: 2, statements: SCHEMA_V2 },
      { toVersion: 3, statements: SCHEMA_V3 },
      { toVersion: 4, statements: SCHEMA_V4 },
    ]);

    // Reconcile this (possibly freshly-constructed) SQLiteConnection's local
    // tracking against what's actually open natively. A fresh instance's
    // internal dict starts empty even if a connection from a previous JS
    // context survived (WebView renderer reset, background Activity
    // reclamation, etc. — none of which necessarily kill the native process
    // holding the real SQLite connection). Without this, isConnection() below
    // wrongly reports false and createConnection() collides with the stale
    // native connection ("Connection skychat-cache already exists").
    await this.sqlite.checkConnectionsConsistency().catch(() => {});

    const isConn = await this.sqlite.isConnection(this.dbName, false);
    if (isConn.result) {
      this.db = await this.sqlite.retrieveConnection(this.dbName, false);
    } else {
      try {
        this.db = await this.sqlite.createConnection(
          this.dbName,
          false,
          'no-encryption',
          DB_VERSION,
          false,
        );
      } catch (err) {
        // Residual case checkConnectionsConsistency() didn't catch: the
        // native connection genuinely exists, so reuse it instead of failing.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.toLowerCase().includes('already exist')) throw err;
        this.db = await this.sqlite.retrieveConnection(this.dbName, false);
      }
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
      r.id, r.conversationId,
      r.encryptedBlob, r.iv,
      r.cacheVersion, r.encryptionVersion,
      r.undecryptable ? 1 : 0,
      r.deletedAt,
      r.createdAt, r.cachedAt,
    ];
  }

  private rowToRecord(row: Record<string, unknown>): EncryptedCacheRecord {
    return {
      id:                row['id'] as string,
      conversationId:    row['conversation_id'] as string,
      encryptedBlob:     row['encrypted_blob'] as string,
      iv:                row['iv'] as string,
      cacheVersion:      row['cache_version'] as number,
      encryptionVersion: row['encryption_version'] as number,
      undecryptable:     row['undecryptable'] === 1,
      deletedAt:         (row['deleted_at'] as number | null | undefined) ?? null,
      createdAt:         row['created_at'] as number,
      cachedAt:          row['cached_at'] as number,
    };
  }

  private async migrateLegacyDb(): Promise<void> {
    const legacyDbName = 'skychat-cache';
    let legacyDb: SQLiteDBConnection | null = null;
    try {
      await this.sqlite.checkConnectionsConsistency().catch(() => {});
      const isConn = await this.sqlite.isConnection(legacyDbName, false);
      if (isConn.result) {
        legacyDb = await this.sqlite.retrieveConnection(legacyDbName, false);
      } else {
        legacyDb = await this.sqlite.createConnection(legacyDbName, false, 'no-encryption', DB_VERSION, false);
      }
      await legacyDb.open();
    } catch {
      return;
    }

    try {
      const res = await legacyDb.query('SELECT * FROM message_cache');
      const rows = res.values || [];
      if (rows.length > 0) {
        console.log('[NativeMessageStore] Migrating legacy message cache SQLite database to:', this.dbName);
        await this.sqlite.addUpgradeStatement(this.dbName, [
          { toVersion: 1, statements: SCHEMA_V1 },
          { toVersion: 2, statements: SCHEMA_V2 },
          { toVersion: 3, statements: SCHEMA_V3 },
          { toVersion: 4, statements: SCHEMA_V4 },
        ]);
        const newDb = await this.sqlite.createConnection(this.dbName, false, 'no-encryption', DB_VERSION, false);
        await newDb.open();

        for (const row of rows) {
          await newDb.run(
            `INSERT OR REPLACE INTO message_cache 
             (id, conversation_id, encrypted_blob, iv, cache_version, encryption_version, undecryptable, deleted_at, created_at, cached_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row['id'], row['conversation_id'], row['encrypted_blob'], row['iv'],
              row['cache_version'] ?? 1, row['encryption_version'] ?? 1,
              row['undecryptable'] ?? 0, row['deleted_at'] ?? null,
              row['created_at'], row['cached_at']
            ]
          );
        }
        await newDb.close();
      }
    } catch (err) {
      console.error('[NativeMessageStore] migrateLegacyDb failed during data copy:', err);
    } finally {
      try {
        if (legacyDb) {
          await legacyDb.delete().catch(() => {});
        }
      } catch {
        // Ignored
      }
    }
  }
}
