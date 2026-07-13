import type { IKeyStore } from './message-cache.types';

const DB_NAME    = 'skychat-message-cache';
// Must match web-message-store.ts's DB_VERSION exactly — both files open this
// same physical IndexedDB database. If they disagree, whichever connection
// opens first (at whatever version) never closes, and the other's open
// request blocks forever instead of resolving or rejecting.
const DB_VERSION = 4;
const KEY_STORE  = 'keys';
const MSG_STORE  = 'messages';

export class WebKeyStore implements IKeyStore {
  private scope = '';
  private db: IDBDatabase | null = null;

  async initialize(scope: string): Promise<void> {
    this.scope = scope;
    const db = await this.openDb();
    await this.getOrCreateKey();
    this.db = db;
  }

  async getOrCreateKey(): Promise<CryptoKey> {
    const db     = await this.openDb();
    const stored = await this.getKeyRecord(db);
    if (stored) return stored.key;

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await this.putKeyRecord(db, key);
    return key;
  }

  async clearKey(): Promise<void> {
    const db = await this.openDb();
    const scope = this.scope;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, 'readwrite');
      tx.objectStore(KEY_STORE).delete(scope);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error ?? new Error('Could not clear key'));
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
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

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open message cache database'));
    });
  }

  private getKeyRecord(db: IDBDatabase): Promise<{ id: string; key: CryptoKey } | null> {
    return new Promise<{ id: string; key: CryptoKey } | null>((resolve, reject) => {
      const tx      = db.transaction(KEY_STORE, 'readonly');
      const request = tx.objectStore(KEY_STORE).get(this.scope);
      request.onsuccess = () =>
        resolve((request.result as { id: string; key: CryptoKey } | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read key store'));
    });
  }

  private putKeyRecord(db: IDBDatabase, key: CryptoKey): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(KEY_STORE, 'readwrite');
      const request = tx.objectStore(KEY_STORE).put({ id: this.scope, key });
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not write key store'));
    });
  }
}
