import { WebSecureLocalStorage } from './web-secure-local-storage';

// DB_NAME/STORE_NAME are private constants in web-secure-local-storage.ts --
// duplicated here ('bluvy-secure' / 'mbk-entries') only for the backward-
// compatibility test below, which needs to write a pre-migration-shaped
// record directly. Keep these in sync if those constants ever change.
const DB_NAME    = 'bluvy-secure';
const STORE_NAME = 'mbk-entries';

describe('WebSecureLocalStorage', () => {
  let storage: WebSecureLocalStorage;
  const USER_DID = 'did:plc:web-storage-test';

  beforeEach(async () => {
    storage = new WebSecureLocalStorage();
    await storage.clearMbk(USER_DID);
  });

  afterEach(async () => {
    await storage.clearMbk(USER_DID);
  });

  it('returns null when nothing is stored', async () => {
    expect(await storage.loadMbk(USER_DID)).toBeNull();
  });

  it('round-trips bytes and keyGeneration together', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    await storage.storeMbk(USER_DID, bytes, 3);

    const result = await storage.loadMbk(USER_DID);

    expect(result).not.toBeNull();
    expect(Array.from(result!.bytes)).toEqual(Array.from(bytes));
    expect(result!.keyGeneration).toBe(3);
  });

  it('overwrites both the bytes and the generation on a second store', async () => {
    await storage.storeMbk(USER_DID, crypto.getRandomValues(new Uint8Array(32)), 1);
    const secondBytes = crypto.getRandomValues(new Uint8Array(32));
    await storage.storeMbk(USER_DID, secondBytes, 2);

    const result = await storage.loadMbk(USER_DID);

    expect(result!.keyGeneration).toBe(2);
    expect(Array.from(result!.bytes)).toEqual(Array.from(secondBytes));
  });

  it('hasMbk reflects presence; clearMbk removes the entry', async () => {
    expect(await storage.hasMbk(USER_DID)).toBe(false);

    await storage.storeMbk(USER_DID, crypto.getRandomValues(new Uint8Array(32)), 1);
    expect(await storage.hasMbk(USER_DID)).toBe(true);

    await storage.clearMbk(USER_DID);
    expect(await storage.hasMbk(USER_DID)).toBe(false);
  });

  it('treats a pre-existing entry without a keyGeneration field as generation 1 (backward compatibility)', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });

    const dwk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const encryptedMbk = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dwk, bytes as BufferSource));

    await new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      // Deliberately omits keyGeneration -- simulates a record written before it existed.
      const req = tx.objectStore(STORE_NAME).put({ userDid: USER_DID, dwk, encryptedMbk, iv });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
    db.close();

    const result = await storage.loadMbk(USER_DID);
    expect(result!.keyGeneration).toBe(1);
    expect(Array.from(result!.bytes)).toEqual(Array.from(bytes));
  });
});
