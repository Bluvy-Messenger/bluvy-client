export interface SecureLocalStorage {
  storeMbk(userDid: string, mbkBytes: Uint8Array): Promise<void>;
  loadMbk(userDid: string): Promise<Uint8Array | null>;
  clearMbk(userDid: string): Promise<void>;
  hasMbk(userDid: string): Promise<boolean>;
}
