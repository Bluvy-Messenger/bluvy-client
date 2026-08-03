// keyGeneration is bumped only on an actual MBK rotation (not on a plain PIN
// re-wrap, see SyncService.changePin) — stored alongside the bytes so a cold
// start can compare it against the backend's current generation (GET
// /sync/settings) without an extra round trip, to detect a device that
// missed the mbk:rotated socket push while offline.
export interface StoredMbk {
  bytes:         Uint8Array;
  keyGeneration: number;
}

export interface SecureLocalStorage {
  storeMbk(userDid: string, mbkBytes: Uint8Array, keyGeneration: number): Promise<void>;
  loadMbk(userDid: string): Promise<StoredMbk | null>;
  clearMbk(userDid: string): Promise<void>;
  hasMbk(userDid: string): Promise<boolean>;
}
