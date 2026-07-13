import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  nativeGetBytes,
  nativeRemoveItem,
  nativeSetBytes,
} from '../conversation/cache/native-secure-storage';
import type {
  Argon2idHkdfParams,
  BackupPayload,
  EncryptedBackupPayload,
} from './backup.types';

// ── Internal helpers ──────────────────────────────────────────────────────────

function b64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64Decode(str: string): Uint8Array<ArrayBuffer> {
  const binary = atob(str);
  const bytes  = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derives the Backup Key from the Recovery Key bytes using Argon2id → HKDF-SHA256.
 *
 * The Master Key is zeroed immediately after HKDF expansion.
 * Returns both the raw bytes (for native Keystore storage) and the CryptoKey
 * (for in-memory use). The caller is responsible for zeroing backupKeyBytes
 * after storing it natively.
 *
 * Uses argon2idAsync to avoid blocking the main thread (required in manual mode
 * where m=65536 takes 3–10 s on mid-range mobile).
 */
export async function deriveBackupKey(
  recoveryKeyBytes: Uint8Array,
  params: Argon2idHkdfParams,
): Promise<{ backupKeyBytes: Uint8Array; backupKey: CryptoKey }> {
  const argon2SaltBytes = b64Decode(params.argon2Salt);
  const hkdfSaltBytes   = b64Decode(params.hkdfSalt);
  const hkdfInfoBytes   = new TextEncoder().encode(params.hkdfInfo);

  const masterKeyBytes = await argon2idAsync(recoveryKeyBytes, argon2SaltBytes, {
    t:     params.argon2Iterations,
    m:     params.argon2Memory,
    p:     params.argon2Parallelism,
    dkLen: params.argon2KeyLength,
  });

  const backupKeyBytes = hkdf(
    sha256,
    masterKeyBytes,
    hkdfSaltBytes,
    hkdfInfoBytes,
    params.keyLength,
  ) as Uint8Array<ArrayBuffer>;

  // Zero the Master Key immediately — it must not outlive this function.
  masterKeyBytes.fill(0);

  const backupKey = await importBackupKey(backupKeyBytes);
  return { backupKeyBytes, backupKey };
}

/**
 * Imports raw AES-GCM-256 key bytes as a non-extractable CryptoKey.
 * Used both after derivation and when loading bytes from native Keystore.
 */
export function importBackupKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    false,   // extractable: false — the key cannot leave WebCrypto
    ['encrypt', 'decrypt'],
  );
}

// ── Encryption / Decryption ───────────────────────────────────────────────────

/**
 * Encrypts a BackupPlaintext with AES-GCM-256.
 * A fresh 12-byte IV is generated per message via crypto.getRandomValues.
 */
export async function encryptForBackup(
  backupKey: CryptoKey,
  plain: BackupPayload,
): Promise<EncryptedBackupPayload> {
  const iv           = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const plainBytes   = new TextEncoder().encode(JSON.stringify(plain));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    backupKey,
    plainBytes,
  );
  return {
    encryptionVersion: 1,
    cacheVersion:      3,
    iv:                b64Encode(iv),
    data:              b64Encode(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Decrypts an EncryptedBackupPayload with AES-GCM-256.
 * Throws if the key or payload is invalid (WebCrypto DOMException).
 */
export async function decryptFromBackup(
  backupKey: CryptoKey,
  payload: EncryptedBackupPayload,
): Promise<BackupPayload> {
  const iv          = b64Decode(payload.iv);
  const cipherBytes = b64Decode(payload.data);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    backupKey,
    cipherBytes,
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer)) as BackupPayload;
}

// ── Native Secure Storage ─────────────────────────────────────────────────────
// These functions are only called on Android / iOS.
// On web, BackupService stores backupKey in memory only and never calls these.

function nativeKeyId(userDid: string, versionNumber: number): string {
  return `backup-key:${userDid}:v${versionNumber}`;
}

export function storeBackupKeyNative(
  userDid: string,
  versionNumber: number,
  bytes: Uint8Array,
): Promise<void> {
  return nativeSetBytes(nativeKeyId(userDid, versionNumber), bytes);
}

export function loadBackupKeyNative(
  userDid: string,
  versionNumber: number,
): Promise<Uint8Array | null> {
  return nativeGetBytes(nativeKeyId(userDid, versionNumber));
}

export function removeBackupKeyNative(
  userDid: string,
  versionNumber: number,
): Promise<void> {
  return nativeRemoveItem(nativeKeyId(userDid, versionNumber));
}
