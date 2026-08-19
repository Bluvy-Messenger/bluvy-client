import { Injectable, inject, signal, computed } from '@angular/core';
import { NotesRepository } from './notes.repository';
import { NotesLocalStoreService } from './notes-local-store.service';
import {
  derivePersonalNotesKey,
  encryptNotePayload,
  decryptNotePayload,
} from './notes.crypto';
import {
  type NoteItem,
  type NotePlaintext,
} from './notes.types';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import { environment } from '../../../environments/environment';

function generateRkey(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}${random}`;
}

@Injectable({ providedIn: 'root' })
export class NotesService {
  private repository   = inject(NotesRepository);
  private localStore   = inject(NotesLocalStoreService);
  private secureStorage = inject(SecureLocalStorageService);

  private pnk: CryptoKey | null = null;
  private keyGeneration = 1;
  private currentDid: string | null = null;

  // ── Reactive Signals ──────────────────────────────────────────────────────────

  readonly notes      = signal<NoteItem[]>([]);
  readonly loading    = signal<boolean>(false);
  readonly syncing    = signal<boolean>(false);
  readonly error      = signal<string | null>(null);

  readonly totalCount = computed(() => this.notes().length);

  /**
   * The most recent note item in the conversation thread.
   */
  readonly latestNote = computed(() => {
    const list = this.notes();
    return list.length > 0 ? list[list.length - 1]! : null;
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async initialize(userDid: string): Promise<void> {
    if (this.currentDid === userDid && this.notes().length > 0) return;

    this.currentDid = userDid;
    this.loading.set(true);
    this.error.set(null);

    try {
      await this.localStore.initialize(userDid);
      const cached = await this.localStore.getAllNotes();
      this.notes.set(cached);

      await this.ensureKey();

      // Background PDS synchronization
      void this.syncWithPds();
    } catch (err) {
      if (!environment.production) console.error('[NotesService] Initialization error:', err);
      this.error.set('Impossible de charger les notes.');
    } finally {
      this.loading.set(false);
    }
  }

  reset(): void {
    this.pnk = null;
    this.keyGeneration = 1;
    this.currentDid = null;
    this.notes.set([]);
    this.loading.set(false);
    this.syncing.set(false);
    this.error.set(null);
    this.localStore.close();
  }

  // ── Key Management ───────────────────────────────────────────────────────────

  private async ensureKey(): Promise<CryptoKey> {
    if (this.pnk) return this.pnk;
    if (!this.currentDid) throw new Error('Not authenticated');

    const stored = await this.secureStorage.loadMbk(this.currentDid);
    if (!stored) {
      throw new Error('Master Backup Key not unlocked locally. Saisissez votre code PIN.');
    }

    this.keyGeneration = stored.keyGeneration;
    this.pnk = await derivePersonalNotesKey(stored.bytes);
    stored.bytes.fill(0);
    return this.pnk;
  }

  // ── CRUD Operations ──────────────────────────────────────────────────────────

  /**
   * Sends a new personal note to the thread.
   * Immediately updates local state (optimistic) and synchronizes to the PDS.
   */
  async sendNote(text: string, tags: string[] = [], pinned = false): Promise<NoteItem> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Note text cannot be empty');

    const pnk = await this.ensureKey();
    const rkey = generateRkey();
    const now = Date.now();

    const localItem: NoteItem = {
      id: rkey,
      text: trimmed,
      tags,
      pinned,
      keyGeneration: this.keyGeneration,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending_upload',
    };

    // Optimistic UI update
    this.notes.update(list => [...list, localItem]);
    await this.localStore.saveNote(localItem);

    // Asynchronous PDS record creation
    void this.pushNoteToPds(localItem, pnk);

    return localItem;
  }

  /**
   * Updates the content of an existing note.
   */
  async editNote(id: string, text: string, tags?: string[], pinned?: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Note text cannot be empty');

    const pnk = await this.ensureKey();
    const existing = this.notes().find(n => n.id === id);
    if (!existing) throw new Error('Note not found');

    const updated: NoteItem = {
      ...existing,
      text: trimmed,
      tags: tags ?? existing.tags,
      pinned: pinned ?? existing.pinned,
      updatedAt: Date.now(),
      syncStatus: 'pending_upload',
    };

    this.notes.update(list => list.map(n => n.id === id ? updated : n));
    await this.localStore.saveNote(updated);

    void this.pushNoteToPds(updated, pnk);
  }

  /**
   * Deletes a note permanently from local store and PDS.
   */
  async deleteNote(id: string): Promise<void> {
    this.notes.update(list => list.filter(n => n.id !== id));
    await this.localStore.deleteNote(id);

    try {
      await this.repository.deleteRecord(id);
    } catch (err) {
      if (!environment.production) console.warn('[NotesService] deleteRecord PDS failed:', err);
    }
  }

  /**
   * Toggles the pinned status of a note.
   */
  async togglePin(id: string): Promise<void> {
    const note = this.notes().find(n => n.id === id);
    if (note) {
      await this.editNote(id, note.text, note.tags, !note.pinned);
    }
  }

  // ── PDS Synchronization ──────────────────────────────────────────────────────

  private async pushNoteToPds(item: NoteItem, pnk: CryptoKey): Promise<void> {
    try {
      const plaintext: NotePlaintext = {
        text: item.text,
        tags: item.tags,
        pinned: item.pinned,
        color: item.color,
      };

      const envelope = await encryptNotePayload(
        pnk,
        plaintext,
        item.keyGeneration,
        new Date(item.createdAt).toISOString(),
      );

      const res = await this.repository.putRecord(item.id, envelope);

      const syncedItem: NoteItem = {
        ...item,
        cid: res.cid,
        syncStatus: 'synced',
      };

      this.notes.update(list => list.map(n => n.id === item.id ? syncedItem : n));
      await this.localStore.saveNote(syncedItem);
    } catch (err) {
      if (!environment.production) console.error('[NotesService] pushNoteToPds failed:', err);
      const errorItem: NoteItem = {
        ...item,
        syncStatus: 'error',
        error: 'Échec de synchronisation PDS',
      };
      this.notes.update(list => list.map(n => n.id === item.id ? errorItem : n));
      await this.localStore.saveNote(errorItem);
    }
  }

  /**
   * Pulls all note records from the PDS, decrypts them with PNK,
   * reconciles them with the local cache (LWW), and uploads any pending offline changes.
   */
  async syncWithPds(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);

    try {
      const pnk = await this.ensureKey();
      let cursor: string | undefined;
      const remoteItems: NoteItem[] = [];

      do {
        const page = await this.repository.listRecords(cursor, 100);
        for (const record of page.records) {
          try {
            const plain = await decryptNotePayload(pnk, record.value);
            const createdAt = new Date(record.value.createdAt).getTime();
            const updatedAt = new Date(record.value.updatedAt).getTime();

            remoteItems.push({
              id: record.rkey,
              cid: record.cid,
              text: plain.text,
              tags: plain.tags ?? [],
              pinned: plain.pinned ?? false,
              color: plain.color,
              keyGeneration: record.value.keyGeneration,
              createdAt: isNaN(createdAt) ? Date.now() : createdAt,
              updatedAt: isNaN(updatedAt) ? Date.now() : updatedAt,
              syncStatus: 'synced',
            });
          } catch {
            // Note could not be decrypted (wrong generation or corrupted)
          }
        }
        cursor = page.cursor;
      } while (cursor);

      // Reconcile with local items
      const localItems = await this.localStore.getAllNotes();
      const localMap = new Map(localItems.map(item => [item.id, item]));
      const mergedMap = new Map<string, NoteItem>();

      // Apply remote items
      for (const remote of remoteItems) {
        const local = localMap.get(remote.id);
        if (!local) {
          mergedMap.set(remote.id, remote);
        } else if (local.syncStatus === 'pending_upload') {
          // If local has pending changes newer than remote, keep local to push
          if (local.updatedAt > remote.updatedAt) {
            mergedMap.set(local.id, local);
          } else {
            mergedMap.set(remote.id, remote);
          }
        } else {
          // Keep newest
          mergedMap.set(remote.id, remote.updatedAt >= local.updatedAt ? remote : local);
        }
      }

      // Check for locally created notes not yet on remote
      for (const local of localItems) {
        if (!mergedMap.has(local.id) && local.syncStatus === 'pending_upload') {
          mergedMap.set(local.id, local);
        }
      }

      const finalNotes = Array.from(mergedMap.values());
      finalNotes.sort((a, b) => a.createdAt - b.createdAt);

      await this.localStore.saveMany(finalNotes);
      this.notes.set(finalNotes);

      // Push any pending uploads
      for (const note of finalNotes) {
        if (note.syncStatus === 'pending_upload') {
          void this.pushNoteToPds(note, pnk);
        }
      }
    } catch (err) {
      if (!environment.production) console.warn('[NotesService] syncWithPds warning:', err);
    } finally {
      this.syncing.set(false);
    }
  }
}
