import { nativeSecureStorage } from '../conversation/cache/native-secure-storage';
import type { SecureLocalStorage, StoredMbk } from './secure-local-storage.interface';

function mbkKey(userDid: string): string {
  return `mbk:${userDid}`;
}

// Native secure storage exposes a single bytes-in/bytes-out entry per key —
// no room for a second field alongside it. keyGeneration is prepended as a
// 4-byte big-endian prefix so the generation and the MBK bytes always read
// and write together atomically (never out of sync from a partial update).
const GENERATION_PREFIX_LENGTH = 4;

export class NativeSecureLocalStorage implements SecureLocalStorage {
  async storeMbk(userDid: string, mbkBytes: Uint8Array, keyGeneration: number): Promise<void> {
    const combined = new Uint8Array(GENERATION_PREFIX_LENGTH + mbkBytes.length);
    new DataView(combined.buffer).setUint32(0, keyGeneration, false);
    combined.set(mbkBytes, GENERATION_PREFIX_LENGTH);
    await nativeSecureStorage.nativeSetBytes(mbkKey(userDid), combined);
  }

  async loadMbk(userDid: string): Promise<StoredMbk | null> {
    const combined = await nativeSecureStorage.nativeGetBytes(mbkKey(userDid));
    if (!combined) return null;

    // Entries written before keyGeneration existed are shorter than the
    // prefix itself — treat them as generation 1, same as the web path.
    if (combined.length < GENERATION_PREFIX_LENGTH) {
      return { bytes: combined, keyGeneration: 1 };
    }

    const keyGeneration = new DataView(combined.buffer, combined.byteOffset, GENERATION_PREFIX_LENGTH).getUint32(0, false);
    const bytes          = combined.slice(GENERATION_PREFIX_LENGTH);
    return { bytes, keyGeneration };
  }

  async clearMbk(userDid: string): Promise<void> {
    await nativeSecureStorage.nativeRemoveItem(mbkKey(userDid));
  }

  async hasMbk(userDid: string): Promise<boolean> {
    const bytes = await nativeSecureStorage.nativeGetBytes(mbkKey(userDid));
    return bytes !== null;
  }
}
