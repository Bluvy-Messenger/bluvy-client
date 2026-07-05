import { Injectable } from '@angular/core';
import type { SyncDataInput } from './sync.types';

interface FailedBatchEntry {
  batchId: string;
  items:   SyncDataInput[];
  savedAt: number;
}

const DB_NAME    = 'skychat-sync-failed';
const DB_VERSION = 1;
const STORE_NAME = 'failed_batches';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class FailedSyncBatchRepository {
  private db: IDBDatabase | null = null;

  async saveBatch(items: SyncDataInput[]): Promise<void> {
    const db    = await this.openDb();
    const entry: FailedBatchEntry = {
      batchId: crypto.randomUUID(),
      items,
      savedAt: Date.now(),
    };
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(entry);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error ?? new Error('Could not save failed batch'));
    });
  }

  async getAll(): Promise<FailedBatchEntry[]> {
    const db = await this.openDb();
    return new Promise<FailedBatchEntry[]>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () =>
        resolve((req.result as FailedBatchEntry[]).sort((a, b) => a.savedAt - b.savedAt));
      req.onerror = () => reject(req.error ?? new Error('Could not read failed batches'));
    });
  }

  async remove(batchId: string): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(batchId);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error ?? new Error('Could not remove failed batch'));
    });
  }

  async clearAll(): Promise<void> {
    const db = await this.openDb();
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error ?? new Error('Could not clear failed batches'));
    });
  }

  async pruneStale(): Promise<void> {
    const db     = await this.openDb();
    const cutoff = Date.now() - MAX_AGE_MS;
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        if ((cursor.value as FailedBatchEntry).savedAt < cutoff) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error('Could not prune failed batches'));
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'batchId' });
        }
      };
      request.onsuccess = () => { this.db = request.result; resolve(request.result); };
      request.onerror   = () =>
        reject(request.error ?? new Error('Could not open failed batches database'));
    });
  }
}
