import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { SecureLocalStorage, StoredMbk } from './secure-local-storage.interface';
import { NativeSecureLocalStorage } from './native-secure-local-storage';
import { WebSecureLocalStorage } from './web-secure-local-storage';

@Injectable({ providedIn: 'root' })
export class SecureLocalStorageService implements SecureLocalStorage {
  private readonly impl: SecureLocalStorage = Capacitor.isNativePlatform()
    ? new NativeSecureLocalStorage()
    : new WebSecureLocalStorage();

  storeMbk(userDid: string, mbkBytes: Uint8Array, keyGeneration: number): Promise<void> {
    return this.impl.storeMbk(userDid, mbkBytes, keyGeneration);
  }

  loadMbk(userDid: string): Promise<StoredMbk | null> {
    return this.impl.loadMbk(userDid);
  }

  clearMbk(userDid: string): Promise<void> {
    return this.impl.clearMbk(userDid);
  }

  hasMbk(userDid: string): Promise<boolean> {
    return this.impl.hasMbk(userDid);
  }
}
