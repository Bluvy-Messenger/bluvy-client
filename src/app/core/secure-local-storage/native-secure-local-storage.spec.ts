import { NativeSecureLocalStorage } from './native-secure-local-storage';
import { nativeSecureStorage } from '../conversation/cache/native-secure-storage';

describe('NativeSecureLocalStorage', () => {
  let storage: NativeSecureLocalStorage;
  let backing: Map<string, Uint8Array<ArrayBuffer>>;
  const USER_DID = 'did:plc:native-storage-test';
  // Matches mbkKey() in native-secure-local-storage.ts (private helper, not exported).
  const STORAGE_KEY = `mbk:${USER_DID}`;

  beforeEach(() => {
    storage = new NativeSecureLocalStorage();
    backing = new Map<string, Uint8Array<ArrayBuffer>>();

    spyOn(nativeSecureStorage, 'nativeSetBytes').and.callFake(async (key: string, bytes: Uint8Array) => {
      backing.set(key, bytes as Uint8Array<ArrayBuffer>);
    });
    spyOn(nativeSecureStorage, 'nativeGetBytes').and.callFake(async (key: string) => backing.get(key) ?? null);
    spyOn(nativeSecureStorage, 'nativeRemoveItem').and.callFake(async (key: string) => { backing.delete(key); });
  });

  it('returns null when nothing is stored', async () => {
    expect(await storage.loadMbk(USER_DID)).toBeNull();
  });

  it('round-trips bytes and keyGeneration via the 4-byte prefix', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    await storage.storeMbk(USER_DID, bytes, 3);

    const result = await storage.loadMbk(USER_DID);

    expect(result).not.toBeNull();
    expect(Array.from(result!.bytes)).toEqual(Array.from(bytes));
    expect(result!.keyGeneration).toBe(3);
  });

  it('encodes generations correctly across the full range, proving it is a 4-byte prefix and not 2', async () => {
    for (const gen of [1, 2, 256, 70_000]) {
      await storage.storeMbk(USER_DID, new Uint8Array([1, 2, 3]), gen);
      const result = await storage.loadMbk(USER_DID);
      expect(result!.keyGeneration).toBe(gen);
    }
  });

  it('treats a pre-existing entry shorter than the 4-byte prefix as generation 1 (backward compatibility)', async () => {
    backing.set(STORAGE_KEY, new Uint8Array([9, 9]));

    const result = await storage.loadMbk(USER_DID);

    expect(result!.keyGeneration).toBe(1);
    expect(Array.from(result!.bytes)).toEqual([9, 9]);
  });

  it('clearMbk removes the stored entry', async () => {
    await storage.storeMbk(USER_DID, new Uint8Array([1]), 1);
    await storage.clearMbk(USER_DID);

    expect(await storage.loadMbk(USER_DID)).toBeNull();
  });

  it('hasMbk reflects presence', async () => {
    expect(await storage.hasMbk(USER_DID)).toBe(false);
    await storage.storeMbk(USER_DID, new Uint8Array([1]), 1);
    expect(await storage.hasMbk(USER_DID)).toBe(true);
  });
});
