import { Injectable } from '@angular/core';

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

const DB_NAME       = 'skychat-pending-decrypts';
const DB_VERSION    = 2;
const STORE_NAME    = 'pending_decrypts';
const STALE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable({ providedIn: 'root' })
export class PendingDecryptRepository {
  private db: IDBDatabase | null = null;

  async enqueue(entry: PendingDecryptEntry): Promise<void> {
    const db = await this.openDb();
    return this.put(db, entry);
  }

  async getAll(conversationId: string): Promise<PendingDecryptEntry[]> {
    const db = await this.openDb();
    return new Promise<PendingDecryptEntry[]>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readonly');
      const index   = tx.objectStore(STORE_NAME).index('by-conversation');
      const range   = IDBKeyRange.only(conversationId);
      const results: PendingDecryptEntry[] = [];
      const request = index.openCursor(range);

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(results.sort((a, b) => a.createdAt - b.createdAt)); return; }
        results.push(cursor.value as PendingDecryptEntry);
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read pending decrypts'));
    });
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
        const entry = req.result as PendingDecryptEntry | undefined;
        if (!entry) { resolve(); return; }
        const updated: PendingDecryptEntry = {
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
        const entry = cursor.value as PendingDecryptEntry;
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

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

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
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open pending decrypts database'));
    });
  }

  private put(db: IDBDatabase, entry: PendingDecryptEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, 'readwrite');
      const request = tx.objectStore(STORE_NAME).put(entry);
      request.onsuccess = () => resolve();
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not write pending decrypt entry'));
    });
  }
}
