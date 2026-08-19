import { Injectable } from '@angular/core';
import type { NoteItem } from './notes.types';

const DB_VERSION = 1;
const STORE_NAME = 'notes';

@Injectable({ providedIn: 'root' })
export class NotesLocalStoreService {
  private db: IDBDatabase | null = null;
  private currentDid: string | null = null;

  async initialize(userDid: string): Promise<void> {
    if (this.currentDid === userDid && this.db) return;

    this.close();
    this.currentDid = userDid;
    const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
    const dbName = `bluvy-notes-${sanitizedDid}`;

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('syncStatus', 'syncStatus', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Could not open notes database'));
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.currentDid = null;
    }
  }

  async getAllNotes(): Promise<NoteItem[]> {
    if (!this.db) return [];
    return new Promise<NoteItem[]>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const items = (req.result as NoteItem[]) ?? [];
        // Sort by createdAt ascending (conversation order: oldest to newest at bottom)
        items.sort((a, b) => a.createdAt - b.createdAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getNote(id: string): Promise<NoteItem | null> {
    if (!this.db) return null;
    return new Promise<NoteItem | null>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);

      req.onsuccess = () => resolve((req.result as NoteItem) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveNote(note: NoteItem): Promise<void> {
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(note);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async saveMany(notes: NoteItem[]): Promise<void> {
    if (!this.db || notes.length === 0) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const note of notes) {
        store.put(note);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.db) return;
    return new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(userDid?: string): Promise<void> {
    this.close();
    if (userDid) {
      const sanitizedDid = userDid.replace(/[^a-zA-Z0-9]/g, '_');
      const dbName = `bluvy-notes-${sanitizedDid}`;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    }
  }
}
