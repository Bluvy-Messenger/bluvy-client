import { nativeGetBytes, nativeSetBytes, nativeRemoveItem } from './native-secure-storage';
import type { IKeyStore } from './message-cache.types';

export class NativeKeyStore implements IKeyStore {
  private scope    = '';
  private cachedKey: CryptoKey | null = null;

  async initialize(scope: string): Promise<void> {
    this.scope    = scope;
    this.cachedKey = null;
    // Pre-warm: ensures SecureStorage prefix is set and key exists before first use.
    await this.getOrCreateKey();
  }

  async getOrCreateKey(): Promise<CryptoKey> {
    if (this.cachedKey) return this.cachedKey;

    let keyBytes = await nativeGetBytes(this.scope);

    if (!keyBytes) {
      // First run: generate and persist raw key bytes.
      keyBytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
      await nativeSetBytes(this.scope, keyBytes);
    }

    // Import as non-extractable CryptoKey — raw bytes stay in Keystore/Keychain.
    this.cachedKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    return this.cachedKey;
  }

  async clearKey(): Promise<void> {
    await nativeRemoveItem(this.scope);
    this.cachedKey = null;
  }
}
