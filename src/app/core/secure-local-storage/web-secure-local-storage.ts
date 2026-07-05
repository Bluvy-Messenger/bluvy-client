import type { SecureLocalStorage } from './secure-local-storage.interface';

const DB_NAME    = 'bluvy-secure';
const DB_VERSION = 1;
const STORE_NAME = 'mbk-entries';

interface MbkEntry {
  userDid:      string;
  dwk:          CryptoKey;
  encryptedMbk: Uint8Array<ArrayBuffer>;
  iv:           Uint8Array<ArrayBuffer>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'userDid' });
      }
    };

    req.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
    req.onerror   = (event) => reject((event.target as IDBOpenDBRequest).error);
  });
}

function idbGet(db: IDBDatabase, userDid: string): Promise<MbkEntry | undefined> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(userDid);
    req.onsuccess = () => resolve(req.result as MbkEntry | undefined);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, entry: MbkEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, userDid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(userDid);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Web implementation of SecureLocalStorage.
 *
 * Generates a Device Wrapping Key (DWK) per-user on first storeMbk() call.
 * The DWK is AES-GCM-256, non-extractable — its key material never leaves
 * the browser's WebCrypto subsystem.
 *
 * The MBK bytes are AES-GCM encrypted with the DWK and stored alongside it
 * in IndexedDB. The CryptoKey object is stored via structured clone, which
 * browsers protect using OS-level key wrapping (DPAPI on Windows, Keychain
 * on macOS, gnome-keyring on Linux).
 *
 * Supported: Chrome 36+, Firefox 75+, Safari 15+.
 */
export class WebSecureLocalStorage implements SecureLocalStorage {
  async storeMbk(userDid: string, mbkBytes: Uint8Array): Promise<void> {
    const db  = await openDb();
    const existing = await idbGet(db, userDid);

    const dwk = existing?.dwk ?? await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    const iv           = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dwk,
      mbkBytes as Uint8Array<ArrayBuffer>,
    );

    await idbPut(db, {
      userDid,
      dwk,
      encryptedMbk: new Uint8Array(cipherBuffer),
      iv,
    });
  }

  async loadMbk(userDid: string): Promise<Uint8Array | null> {
    const db    = await openDb();
    const entry = await idbGet(db, userDid);
    if (!entry) return null;

    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: entry.iv as Uint8Array<ArrayBuffer> },
      entry.dwk,
      entry.encryptedMbk as Uint8Array<ArrayBuffer>,
    );

    return new Uint8Array(plainBuffer);
  }

  async clearMbk(userDid: string): Promise<void> {
    const db = await openDb();
    await idbDelete(db, userDid);
  }

  async hasMbk(userDid: string): Promise<boolean> {
    const db    = await openDb();
    const entry = await idbGet(db, userDid);
    return entry !== undefined;
  }
}
