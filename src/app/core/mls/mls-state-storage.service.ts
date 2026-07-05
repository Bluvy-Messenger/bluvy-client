import { Injectable } from '@angular/core';

interface EncryptedStateRecord {
  ciphertext: string;
  iv:         string;
  updatedAt:  number;
}

@Injectable({ providedIn: 'root' })
export class MlsStateStorageService {
  private readonly dbName        = 'skychat-mls-state';
  private readonly dbVersion     = 2;
  private readonly keyStoreName  = 'keys';
  private readonly stateStoreName = 'states';

  // Per-scope serialization queue — each scope's operations run one at a time.
  // Uses promise chaining so no external mutex library is required.
  private readonly locks = new Map<string, Promise<unknown>>();

  // ── Public API ─────────────────────────────────────────────────────────────

  async clearAll(): Promise<void> {
    const db = await this.openDb();
    await this.clearObjectStore(db, this.keyStoreName);
    await this.clearObjectStore(db, this.stateStoreName);
    this.locks.clear();
  }

  // Read-only access. Safe to call without the lock; callers that need a
  // consistent read-then-write must use update() instead.
  async load<T>(scope: string): Promise<T | null> {
    const db     = await this.openDb();
    const key    = await this.getOrCreateKey(db, scope);
    const record = await this.getRecord<EncryptedStateRecord>(db, this.stateStoreName, scope);

    if (!record) return null;

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.base64ToBytes(record.iv) },
      key,
      this.base64ToBytes(record.ciphertext),
    );

    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  }

  // Atomically: acquires the per-scope lock → loads latest state → runs updater
  // → saves the result → releases the lock.
  //
  // The updater receives null when no state exists yet.
  // Returning null from the updater skips the save (no-op / early-exit).
  //
  // The lock is held only for the duration of load + updater + save.
  // Network calls, Socket.IO, timeouts and long-running crypto MUST NOT appear
  // inside the updater; run them before calling update() and capture the results
  // in closed-over variables.
  async update<T>(
    scope:   string,
    updater: (state: T | null) => Promise<T | null>,
  ): Promise<void> {
    await this.withLock(scope, async () => {
      const current = await this.load<T>(scope);
      const next    = await updater(current);
      if (next !== null) {
        await this.save(scope, next);
      }
    });
  }

  // ── Lock implementation ────────────────────────────────────────────────────

  // Chains fn after any in-progress operation for the scope.
  // fn always runs even when the previous operation rejected, so a single
  // failure cannot stall the queue permanently.
  private withLock<R>(scope: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.locks.get(scope) ?? Promise.resolve<unknown>(undefined);

    // Chain fn regardless of whether prev resolved or rejected.
    const current: Promise<R> = prev.then(
      () => fn(),
      () => fn(),
    );

    // Gate: resolves when current settles, suppresses its error so the next
    // operation can chain without propagating an upstream failure.
    const gate: Promise<unknown> = current.then(
      () => undefined,
      () => undefined,
    );

    this.locks.set(scope, gate);

    // Remove the entry when this becomes the last settled gate.
    void gate.then(() => {
      if (this.locks.get(scope) === gate) this.locks.delete(scope);
    });

    return current;
  }

  // ── Storage primitives ─────────────────────────────────────────────────────

  // Reserved for update(). Direct callers outside this service are a bug.
  private async save(scope: string, value: unknown): Promise<void> {
    const db        = await this.openDb();
    const key       = await this.getOrCreateKey(db, scope);
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );

    await this.putRecord(db, this.stateStoreName, {
      id:         scope,
      ciphertext: this.bytesToBase64(new Uint8Array(ciphertext)),
      iv:         this.bytesToBase64(iv),
      updatedAt:  Date.now(),
    });
  }

  private async openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = request.result;
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          if (db.objectStoreNames.contains(this.keyStoreName))   db.deleteObjectStore(this.keyStoreName);
          if (db.objectStoreNames.contains(this.stateStoreName)) db.deleteObjectStore(this.stateStoreName);
        }
        if (!db.objectStoreNames.contains(this.keyStoreName)) {
          db.createObjectStore(this.keyStoreName, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(this.stateStoreName)) {
          db.createObjectStore(this.stateStoreName, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror   = () => reject(request.error ?? new Error('Could not open MLS state database'));
    });
  }

  private clearObjectStore(db: IDBDatabase, storeName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).clear();
      request.onsuccess = () => resolve();
      request.onerror   = () => reject(request.error ?? new Error(`Could not clear ${storeName}`));
    });
  }

  private async getOrCreateKey(db: IDBDatabase, scope: string): Promise<CryptoKey> {
    const existing = await this.getRecord<{ id: string; key: CryptoKey }>(db, this.keyStoreName, scope);
    if (existing) return existing.key;

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await this.putRecord(db, this.keyStoreName, { id: scope, key });
    return key;
  }

  private async getRecord<T>(db: IDBDatabase, storeName: string, id: string): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      const tx      = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(id);

      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror   = () => reject(request.error ?? new Error(`Could not read ${storeName}`));
    });
  }

  private async putRecord(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx      = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).put(value);

      request.onsuccess = () => resolve();
      request.onerror   = () => reject(request.error ?? new Error(`Could not write ${storeName}`));
    });
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(v => { binary += String.fromCharCode(v); });
    return btoa(binary);
  }

  private base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
