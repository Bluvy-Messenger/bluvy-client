import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { IKeyStore } from '../../conversation/cache/message-cache.types';
import { WebKeyStore }    from '../../conversation/cache/web-key-store';
import { NativeKeyStore } from '../../conversation/cache/native-key-store';

export interface PendingDecryptEntry {
  messageId:      string;
  conversationId: string;
  ciphertext:     string;
  senderDid:      string;
  senderDeviceId: string;
  isMine:         boolean;
  createdAt:      number;
  enqueuedAt:     number;
  attempts:       number;
  lastAttemptAt:  number | null;
}

// On-disk shape: messageId/conversationId/enqueuedAt stay plaintext (indexed —
// IndexedDB can't query into an encrypted blob), ciphertext stays plaintext
// (it's already MLS-opaque, not decryptable without the group's own key), and
// attempts/lastAttemptAt are non-sensitive retry counters. senderDid/senderDeviceId/
// isMine/createdAt are message metadata, so they're wrapped in the same
// per-(userDid,deviceId) AES-GCM key MessageCacheService already uses.
interface StoredPendingDecryptRecord {
  messageId:      string;
  conversationId: string;
  ciphertext:     string;
  enqueuedAt:     number;
  attempts:       number;
  lastAttemptAt:  number | null;
  encryptedMeta:  string;
  metaIv:         string;
}

interface EncryptedMeta {
  senderDid:      string;
  senderDeviceId: string;
  isMine:         boolean;
  createdAt:      number;
}

const DB_VERSION    = 3;
const STORE_NAME    = 'pending_decrypts';
const STALE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable({ providedIn: 'root' })
export class PendingDecryptRepository {
  private db: IDBDatabase | null = null;
  private keyStore: IKeyStore | null = null;
  private dbName = 'skychat-pending-decrypts';

  // Uses the same `cache:{userDid}:{deviceId}` scope as MessageCacheService's
  // key store, so both resolve to the same underlying key without introducing
  // a second key hierarchy.
  async initialize(userDid: string, deviceId: string): Promise<void> {
    const scope = `cache:${userDid}:${deviceId}`;
    const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
    this.dbName = `skychat-pending-decrypts-${sanitizedDid}`;
    this.keyStore = Capacitor.isNativePlatform() ? new NativeKeyStore() : new WebKeyStore(sanitizedDid);
    await this.keyStore.initialize(scope);
    this.db = null; // Reset database connection
  }

  async enqueue(entry: PendingDecryptEntry): Promise<void> {
    const db     = await this.openDb();
    const stored = await this.toStored(entry);
    return this.put(db, stored);
  }

  async getAll(conversationId: string): Promise<PendingDecryptEntry[]> {
    const db = await this.openDb();
    const stored = await new Promise<StoredPendingDecryptRecord[]>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readonly');
      const index   = tx.objectStore(STORE_NAME).index('by-conversation');
      const range   = IDBKeyRange.only(conversationId);
      const results: StoredPendingDecryptRecord[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value as StoredPendingDecryptRecord);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read pending decrypts'));
    });

    const entries = await Promise.all(stored.map(r => this.fromStored(r)));
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  async remove(messageId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).delete(messageId);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not remove pending decrypt'));
    });
  }

  async markAttempt(messageId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(messageId);
      req.onsuccess = () => {
        const entry = req.result as StoredPendingDecryptRecord | undefined;
        if (!entry) { resolve(); return; }
        const updated: StoredPendingDecryptRecord = {
          ...entry,
          attempts:      entry.attempts + 1,
          lastAttemptAt: Date.now(),
        };
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve();
        putReq.onerror   = () =>
          reject(putReq.error ?? new Error('Could not update pending decrypt attempts'));
      };
      req.onerror = () =>
        reject(req.error ?? new Error('Could not read pending decrypt for markAttempt'));
    });
  }

  async clearAll(): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).clear();
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not clear all pending decrypts'));
    });
  }

  async clear(conversationId: string): Promise<void> {
    const entries = await this.getAll(conversationId);
    const db      = await this.openDb();

    if (entries.length === 0) return;

    return new Promise<void>((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let   i     = 0;

      const deleteNext = (): void => {
        if (i >= entries.length) return;
        const req = store.delete(entries[i++]!.messageId);
        req.onsuccess = deleteNext;
        req.onerror   = () =>
          reject(req.error ?? new Error('Could not clear pending decrypts'));
      };

      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error ?? new Error('Clear transaction failed'));
      deleteNext();
    });
  }

  // Removes entries older than maxAgeMs. Called at session start to prevent unbounded growth.
  async pruneStale(maxAgeMs: number = STALE_TTL_MS): Promise<number> {
    const db      = await this.openDb();
    const cutoff  = Date.now() - maxAgeMs;

    return new Promise<number>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const store   = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      let   pruned  = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(pruned); return; }
        const entry = cursor.value as StoredPendingDecryptRecord;
        if (entry.enqueuedAt < cutoff) {
          const del = cursor.delete();
          del.onsuccess = () => { pruned++; cursor.continue(); };
          del.onerror   = () => reject(del.error);
        } else {
          cursor.continue();
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not prune pending decrypts'));
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async toStored(entry: PendingDecryptEntry): Promise<StoredPendingDecryptRecord> {
    const key: CryptoKey = await this.getKey();
    const iv        = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const meta: EncryptedMeta = {
      senderDid:      entry.senderDid,
      senderDeviceId: entry.senderDeviceId,
      isMine:         entry.isMine,
      createdAt:      entry.createdAt,
    };
    const plaintext  = new TextEncoder().encode(JSON.stringify(meta));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    return {
      messageId:      entry.messageId,
      conversationId: entry.conversationId,
      ciphertext:     entry.ciphertext,
      enqueuedAt:     entry.enqueuedAt,
      attempts:       entry.attempts,
      lastAttemptAt:  entry.lastAttemptAt,
      encryptedMeta:  this.bytesToBase64(new Uint8Array(ciphertext)),
      metaIv:         this.bytesToBase64(iv),
    };
  }

  private async fromStored(record: StoredPendingDecryptRecord): Promise<PendingDecryptEntry> {
    const key        = await this.getKey();
    const iv          = this.base64ToBytes(record.metaIv);
    const ciphertext  = this.base64ToBytes(record.encryptedMeta);
    const plaintext   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const meta        = JSON.parse(new TextDecoder().decode(plaintext)) as EncryptedMeta;

    return {
      messageId:      record.messageId,
      conversationId: record.conversationId,
      ciphertext:     record.ciphertext,
      senderDid:      meta.senderDid,
      senderDeviceId: meta.senderDeviceId,
      isMine:         meta.isMine,
      createdAt:      meta.createdAt,
      enqueuedAt:     record.enqueuedAt,
      attempts:       record.attempts,
      lastAttemptAt:  record.lastAttemptAt,
    };
  }

  private async getKey(): Promise<CryptoKey> {
    if (!this.keyStore) {
      throw new Error('PendingDecryptRepository.initialize() must be called before use');
    }
    return this.keyStore.getOrCreateKey();
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }

  private base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = request.result;
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
          store.createIndex('by-conversation', 'conversationId', { unique: false });
          store.createIndex('by-enqueued',     'enqueuedAt',     { unique: false });
        }
        // v2 -> v3: senderDid/senderDeviceId/isMine/createdAt moved from plaintext
        // fields into an encrypted envelope (encryptedMeta/metaIv). Re-encrypting
        // existing rows here would need async WebCrypto calls, which don't reliably
        // survive an IDB versionchange transaction — instead drop them. This is a
        // transient retry queue (pruned after 7 days anyway); the normal reconnect/
        // catch-up flow re-triggers decryption for anything still undelivered.
        if (event.oldVersion > 0 && event.oldVersion < 3 && db.objectStoreNames.contains(STORE_NAME)) {
          request.transaction!.objectStore(STORE_NAME).clear();
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open pending decrypts database'));
    });
  }

  private put(db: IDBDatabase, record: StoredPendingDecryptRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).put(record);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not write pending decrypt entry'));
    });
  }

  async clearAllForUser(userDid: string): Promise<void> {
    const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
    const dbName = `skychat-pending-decrypts-${sanitizedDid}`;
    
    if (this.db && this.dbName === dbName) {
      this.db.close();
      this.db = null;
    }
    
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  }
}
