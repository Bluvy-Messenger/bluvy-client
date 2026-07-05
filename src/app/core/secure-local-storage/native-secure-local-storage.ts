import {
  nativeGetBytes,
  nativeRemoveItem,
  nativeSetBytes,
} from '../conversation/cache/native-secure-storage';
import type { SecureLocalStorage } from './secure-local-storage.interface';

function mbkKey(userDid: string): string {
  return `mbk:${userDid}`;
}

export class NativeSecureLocalStorage implements SecureLocalStorage {
  async storeMbk(userDid: string, mbkBytes: Uint8Array): Promise<void> {
    await nativeSetBytes(mbkKey(userDid), mbkBytes);
  }

  async loadMbk(userDid: string): Promise<Uint8Array | null> {
    const bytes = await nativeGetBytes(mbkKey(userDid));
    return bytes ?? null;
  }

  async clearMbk(userDid: string): Promise<void> {
    await nativeRemoveItem(mbkKey(userDid));
  }

  async hasMbk(userDid: string): Promise<boolean> {
    const bytes = await nativeGetBytes(mbkKey(userDid));
    return bytes !== null;
  }
}
