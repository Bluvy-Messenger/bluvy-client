import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { IKeyStore } from './cache/message-cache.types';
import { WebKeyStore }    from './cache/web-key-store';
import { NativeKeyStore } from './cache/native-key-store';

export interface OutboxEntry {
  localId:        string;
  conversationId: string;
  plaintext:      string;
  createdAt:      number;
}

// On-disk shape: localId/conversationId/createdAt stay plaintext (needed for
// the primary key and the by-conversation index -- IndexedDB can't query into
// an encrypted blob). plaintext is the user's actual message text, so it's
// wrapped in the same per-(userDid,deviceId) AES-GCM key MessageCacheService
// and PendingDecryptRepository already use, for the same at-rest guarantee.
interface StoredOutboxRecord {
  localId:        string;
  conversationId: string;
  createdAt:      number;
  encryptedText:  string;
  textIv:         string;
}

const DB_VERSION = 1;
const STORE_NAME  = 'outbox';

// Durable record of a message a user has just hit "send" on, written BEFORE
// the network attempt -- so the typed text survives the app being killed
// between encrypting/posting the message and writing the final record into
// MessageCacheService (whose primary key, the server-assigned message id,
// doesn't exist yet at send time). Removed once that final write succeeds.
// No automatic resend on next launch: the socket send has no client-supplied
// idempotency key, so blindly retrying could double-post a message that
// actually reached the server but whose local ack was never processed.
// Instead the plaintext is restored into the composer's input field for the
// user to resend (or discard) themselves.
@Injectable({ providedIn: 'root' })
export class OutboxRepository {
  private db: IDBDatabase | null = null;
  private keyStore: IKeyStore | null = null;
  private dbName = 'skychat-outbox';
  private initializedScope: string | null = null;

  async initialize(userDid: string, deviceId: string): Promise<void> {
    const scope = `cache:${userDid}:${deviceId}`;
    if (this.initializedScope === scope) return;

    const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
    this.dbName = `skychat-outbox-${sanitizedDid}`;
    this.keyStore = Capacitor.isNativePlatform() ? new NativeKeyStore() : new WebKeyStore(sanitizedDid);
    await this.keyStore.initialize(scope);
    this.db = null;
    this.initializedScope = scope;
  }

  async add(entry: OutboxEntry): Promise<void> {
    const db     = await this.openDb();
    const stored = await this.toStored(entry);
    return this.put(db, stored);
  }

  async getByConversation(conversationId: string): Promise<OutboxEntry[]> {
    const db = await this.openDb();
    const stored = await new Promise<StoredOutboxRecord[]>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readonly');
      const index   = tx.objectStore(STORE_NAME).index('by-conversation');
      const range   = IDBKeyRange.only(conversationId);
      const results: StoredOutboxRecord[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value as StoredOutboxRecord);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read outbox entries'));
    });

    const entries = await Promise.all(stored.map(r => this.fromStored(r)));
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }

  async remove(localId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).delete(localId);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not remove outbox entry'));
    });
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async toStored(entry: OutboxEntry): Promise<StoredOutboxRecord> {
    const key = await this.getKey();
    const iv  = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const plaintextBytes = new TextEncoder().encode(entry.plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes);

    return {
      localId:        entry.localId,
      conversationId: entry.conversationId,
      createdAt:      entry.createdAt,
      encryptedText:  this.bytesToBase64(new Uint8Array(ciphertext)),
      textIv:         this.bytesToBase64(iv),
    };
  }

  private async fromStored(record: StoredOutboxRecord): Promise<OutboxEntry> {
    const key        = await this.getKey();
    const iv         = this.base64ToBytes(record.textIv);
    const ciphertext = this.base64ToBytes(record.encryptedText);
    const plaintext  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    return {
      localId:        record.localId,
      conversationId: record.conversationId,
      createdAt:      record.createdAt,
      plaintext:      new TextDecoder().decode(plaintext),
    };
  }

  private async getKey(): Promise<CryptoKey> {
    if (!this.keyStore) {
      throw new Error('OutboxRepository.initialize() must be called before use');
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

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'localId' });
          store.createIndex('by-conversation', 'conversationId', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open outbox database'));
    });
  }

  private put(db: IDBDatabase, record: StoredOutboxRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).put(record);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not write outbox entry'));
    });
  }
}
