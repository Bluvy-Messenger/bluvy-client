import { SecureStorage } from '@aparajita/capacitor-secure-storage';

const KEY_PREFIX = 'skychat_';

// Set once per app lifetime. Module-level flag survives across calls
// within the same JS context.
let prefixReady = false;

async function ensurePrefix(): Promise<void> {
  if (prefixReady) return;
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  prefixReady = true;
}

// ── Public API ──────────────────────────────────────────────────────────────
// Used by NativeKeyStore (cache keys) and, in later phases, by BackupService
// (Master Key, Backup Key) — any code that needs Android Keystore / iOS Keychain.
// All keys are stored under the 'skychat_' prefix in the native secure store.
// Convention:
//   cache:{userDid}:{deviceId}   → AES cache key (this file)
//   master-key:{userDid}         → Master Key bytes (BackupService, Phase 3)
//   backup-key:{userDid}         → Backup Key bytes (BackupService, Phase 3)

export async function nativeSetBytes(key: string, bytes: Uint8Array): Promise<void> {
  await ensurePrefix();
  await SecureStorage.set(key, bytesToBase64(bytes));
}

export async function nativeGetBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  await ensurePrefix();
  const stored = await SecureStorage.get(key, false) as string | null;
  return stored ? base64ToBytes(stored) : null;
}

export async function nativeRemoveItem(key: string): Promise<void> {
  await ensurePrefix();
  await SecureStorage.remove(key);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes  = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
