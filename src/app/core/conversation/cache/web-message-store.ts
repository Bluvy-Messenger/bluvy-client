import { Preferences } from '@capacitor/preferences';
import type { EncryptedCacheRecord, IMessageStore } from './message-cache.types';

const DB_VERSION = 4;
const KEY_STORE  = 'keys';
const MSG_STORE  = 'messages';

export class WebMessageStore implements IMessageStore {
  private db: IDBDatabase | null = null;
  private dbName = 'skychat-message-cache';
  private sanitizedDid = '';

  constructor(sanitizedDid: string) {
    this.sanitizedDid = sanitizedDid;
    this.dbName = `skychat-message-cache-${sanitizedDid}`;
  }

  async initialize(): Promise<void> {
    const migrationKey = `migration.cache.${this.sanitizedDid}`;
    const { value: migrated } = await Preferences.get({ key: migrationKey });
    if (!migrated) {
      try {
        await this.migrateLegacyDb();
      } catch (err) {
        console.error('[WebMessageStore] Migration failed:', err);
      }
      await Preferences.set({ key: migrationKey, value: 'true' });
    }
    this.db = await this.openDb();
  }

  async put(record: EncryptedCacheRecord): Promise<void> {
    const db = await this.openDb();
    return this.putRecord(db, record);
  }

  async putMany(records: EncryptedCacheRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.openDb();
    return this.putManyRecords(db, records);
  }

  async has(id: string): Promise<boolean> {
    const db = await this.openDb();
    return this.hasRecord(db, id);
  }

  async get(id: string): Promise<EncryptedCacheRecord | null> {
    const db = await this.openDb();
    return this.getRecord(db, id);
  }

  async queryByConversation(conversationId: string, limit: number): Promise<EncryptedCacheRecord[]> {
    const db = await this.openDb();
    return this.queryByConversationImpl(db, conversationId, limit);
  }

  async queryAllIds(conversationId: string): Promise<string[]> {
    const db = await this.openDb();
    return this.queryAllIdsImpl(db, conversationId);
  }

  async queryNewestId(conversationId: string): Promise<string | null> {
    const db = await this.openDb();
    return this.queryNewestIdImpl(db, conversationId);
  }

  async queryByConversationPaged(
    conversationId: string,
    afterCreatedAt: number,
    limit: number,
  ): Promise<EncryptedCacheRecord[]> {
    const db = await this.openDb();
    return this.queryByConversationPagedImpl(db, conversationId, afterCreatedAt, limit);
  }

  async updateDeletedAt(id: string, deletedAt: number): Promise<void> {
    const db     = await this.openDb();
    const record = await this.getRecord(db, id);
    if (!record) return;
    await this.putRecord(db, { ...record, deletedAt });
  }

  async delete(id: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readwrite');
      const request = tx.objectStore(MSG_STORE).delete(id);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not delete cache record'));
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readwrite');
      const request = tx.objectStore(MSG_STORE).clear();
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not clear message cache'));
    });
  }

  async clearConversation(conversationId: string): Promise<void> {
    const db = await this.openDb();
    const ids = await this.queryAllIds(conversationId);
    return new Promise<void>((resolve, reject) => {
      if (ids.length === 0) return resolve();
      const tx = db.transaction(MSG_STORE, 'readwrite');
      const store = tx.objectStore(MSG_STORE);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not clear conversation messages'));
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = request.result;
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          if (db.objectStoreNames.contains(KEY_STORE)) db.deleteObjectStore(KEY_STORE);
          if (db.objectStoreNames.contains(MSG_STORE)) db.deleteObjectStore(MSG_STORE);
        }
        if (!db.objectStoreNames.contains(KEY_STORE)) {
          db.createObjectStore(KEY_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(MSG_STORE)) {
          const store = db.createObjectStore(MSG_STORE, { keyPath: 'id' });
          store.createIndex('by-conversation-created', ['conversationId', 'createdAt'], { unique: false });
          store.createIndex('by-conversation-id',      ['conversationId', 'id'],        { unique: false });
          store.createIndex('by-deleted',              'deletedAt',                     { unique: false });
          store.createIndex('by-cache-version',        'cacheVersion',                  { unique: false });
          store.createIndex('by-encryption-version',   'encryptionVersion',             { unique: false });
        }
        // v3 -> v4: senderDeviceId/senderDid/isMine used to be duplicated in
        // plaintext on the record — they're already inside the encrypted blob,
        // so strip the plaintext copies from every existing row.
        if (event.oldVersion > 0 && event.oldVersion < 4 && db.objectStoreNames.contains(MSG_STORE)) {
          const store  = request.transaction!.objectStore(MSG_STORE);
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const cur = cursor.result;
            if (!cur) return;
            const record = cur.value as EncryptedCacheRecord & {
              senderDeviceId?: string; senderDid?: string; isMine?: boolean;
            };
            if ('senderDeviceId' in record || 'senderDid' in record || 'isMine' in record) {
              delete record.senderDeviceId;
              delete record.senderDid;
              delete record.isMine;
              cur.update(record);
            }
            cur.continue();
          };
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open message cache database'));
    });
  }

  private putRecord(db: IDBDatabase, record: EncryptedCacheRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readwrite');
      const request = tx.objectStore(MSG_STORE).put(record);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not write message cache'));
    });
  }

  private putManyRecords(db: IDBDatabase, records: EncryptedCacheRecord[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx    = db.transaction(MSG_STORE, 'readwrite');
      const store = tx.objectStore(MSG_STORE);
      let i = 0;

      const putNext = (): void => {
        if (i >= records.length) return;
        const req = store.put(records[i++]);
        req.onsuccess = putNext;
        req.onerror   = () =>
          reject(req.error ?? new Error('Batch write to cache failed'));
      };

      tx.oncomplete = () => resolve();
      tx.onerror    = () =>
        reject(tx.error ?? new Error('Batch write transaction failed'));
      putNext();
    });
  }

  private hasRecord(db: IDBDatabase, id: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const request = tx.objectStore(MSG_STORE).count(id);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not check cache'));
    });
  }

  private getRecord(db: IDBDatabase, id: string): Promise<EncryptedCacheRecord | null> {
    return new Promise<EncryptedCacheRecord | null>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const request = tx.objectStore(MSG_STORE).get(id);
      request.onsuccess = () =>
        resolve((request.result as EncryptedCacheRecord | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read cache record'));
    });
  }

  private queryByConversationImpl(
    db: IDBDatabase,
    conversationId: string,
    limit: number,
  ): Promise<EncryptedCacheRecord[]> {
    return new Promise<EncryptedCacheRecord[]>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const index   = tx.objectStore(MSG_STORE).index('by-conversation-created');
      const range   = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER],
      );
      const results: EncryptedCacheRecord[] = [];
      const request = index.openCursor(range, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= limit) {
          resolve(results.reverse());
          return;
        }
        results.push(cursor.value as EncryptedCacheRecord);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not query message cache'));
    });
  }

  private queryAllIdsImpl(db: IDBDatabase, conversationId: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const index   = tx.objectStore(MSG_STORE).index('by-conversation-created');
      const range   = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER],
      );
      const ids: string[] = [];
      const request = index.openKeyCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(ids); return; }
        ids.push(cursor.primaryKey as string);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not query cache IDs'));
    });
  }

  private queryByConversationPagedImpl(
    db: IDBDatabase,
    conversationId: string,
    afterCreatedAt: number,
    limit: number,
  ): Promise<EncryptedCacheRecord[]> {
    return new Promise<EncryptedCacheRecord[]>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const index   = tx.objectStore(MSG_STORE).index('by-conversation-created');
      // lowerOpen: true → strictly after afterCreatedAt (exclusive lower bound)
      const range   = IDBKeyRange.bound(
        [conversationId, afterCreatedAt],
        [conversationId, Number.MAX_SAFE_INTEGER],
        true,
        false,
      );
      const results: EncryptedCacheRecord[] = [];
      const request = index.openCursor(range, 'next'); // ASC by createdAt

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        results.push(cursor.value as EncryptedCacheRecord);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not query paged message cache'));
    });
  }

  private queryNewestIdImpl(db: IDBDatabase, conversationId: string): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const tx      = db.transaction(MSG_STORE, 'readonly');
      const index   = tx.objectStore(MSG_STORE).index('by-conversation-created');
      const range   = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER],
      );
      const request = index.openKeyCursor(range, 'prev');

      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? (cursor.primaryKey as string) : null);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not query newest ID'));
    });
  }

  private async migrateLegacyDb(): Promise<void> {
    const legacyDbName = 'skychat-message-cache';
    
    const legacyDb = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(legacyDbName, DB_VERSION);
      req.onupgradeneeded = () => {
        (req as any).isNew = true;
      };
      req.onsuccess = () => {
        const db = req.result;
        if ((req as any).isNew || !db.objectStoreNames.contains(MSG_STORE)) {
          db.close();
          indexedDB.deleteDatabase(legacyDbName);
          resolve(null);
        } else {
          resolve(db);
        }
      };
      req.onerror = () => resolve(null);
    });

    if (!legacyDb) return;

    console.log('[WebMessageStore] Migrating legacy message cache IndexedDB database to:', this.dbName);

    const newDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEY_STORE)) {
          db.createObjectStore(KEY_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(MSG_STORE)) {
          const store = db.createObjectStore(MSG_STORE, { keyPath: 'id' });
          store.createIndex('by-conversation-created', ['conversationId', 'createdAt'], { unique: false });
          store.createIndex('by-conversation-id',      ['conversationId', 'id'],        { unique: false });
          store.createIndex('by-deleted',              'deletedAt',                     { unique: false });
          store.createIndex('by-cache-version',        'cacheVersion',                  { unique: false });
          store.createIndex('by-encryption-version',   'encryptionVersion',             { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open new database during migration'));
    });

    // Copy keys
    const keys = await new Promise<any[]>((resolve) => {
      const tx = legacyDb.transaction(KEY_STORE, 'readonly');
      const req = tx.objectStore(KEY_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });

    if (keys.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = newDb.transaction(KEY_STORE, 'readwrite');
        const store = tx.objectStore(KEY_STORE);
        keys.forEach(k => store.put(k));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // Copy messages
    const messages = await new Promise<any[]>((resolve) => {
      const tx = legacyDb.transaction(MSG_STORE, 'readonly');
      const req = tx.objectStore(MSG_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });

    if (messages.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = newDb.transaction(MSG_STORE, 'readwrite');
        const store = tx.objectStore(MSG_STORE);
        messages.forEach(m => store.put(m));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    legacyDb.close();
    newDb.close();

    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(legacyDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });

    console.log('[WebMessageStore] IndexedDB migration complete.');
  }
}
