import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Argon2idHkdfParams, EncryptedSyncPayload, MbkEncryptedBlob, SyncPayload } from './sync.types';

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

// ── KDF params builders ───────────────────────────────────────────────────────

export function buildPinKdfParams(): Argon2idHkdfParams {
  return {
    argon2Salt:        b64Encode(crypto.getRandomValues(new Uint8Array(32))),
    argon2Memory:      65536,
    argon2Iterations:  3,
    argon2Parallelism: 4,
    argon2KeyLength:   32,
    hkdfSalt:          b64Encode(crypto.getRandomValues(new Uint8Array(32))),
    hkdfInfo:          'bluvy-sync-pin-v1',
    hashAlgorithm:     'sha256',
    keyLength:         32,
  };
}

export function buildRecoveryKeyKdfParams(): Argon2idHkdfParams {
  return {
    argon2Salt:        b64Encode(crypto.getRandomValues(new Uint8Array(32))),
    argon2Memory:      65536,
    argon2Iterations:  3,
    argon2Parallelism: 4,
    argon2KeyLength:   32,
    hkdfSalt:          b64Encode(crypto.getRandomValues(new Uint8Array(32))),
    hkdfInfo:          'bluvy-sync-recovery-v1',
    hashAlgorithm:     'sha256',
    keyLength:         32,
  };
}

// ── MBK import ────────────────────────────────────────────────────────────────

export function importMbk(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── PIN key derivation ────────────────────────────────────────────────────────

/**
 * Derives an AES-GCM-256 wrapping key from the user's PIN via Argon2id → HKDF.
 * Used to encrypt/decrypt the MBK blob stored on the backend.
 * Takes ~300-500 ms on mid-range device with m=65536.
 */
export async function deriveMbkWrappingKeyFromPin(
  pin:    string,
  params: Argon2idHkdfParams,
): Promise<CryptoKey> {
  const pinBytes        = new TextEncoder().encode(pin);
  const argon2SaltBytes = b64Decode(params.argon2Salt);
  const hkdfSaltBytes   = b64Decode(params.hkdfSalt);
  const hkdfInfoBytes   = new TextEncoder().encode(params.hkdfInfo);

  const masterKeyBytes = await argon2idAsync(pinBytes, argon2SaltBytes, {
    t:     params.argon2Iterations,
    m:     params.argon2Memory,
    p:     params.argon2Parallelism,
    dkLen: params.argon2KeyLength,
  });

  const wrappingKeyBytes = hkdf(
    sha256,
    masterKeyBytes,
    hkdfSaltBytes,
    hkdfInfoBytes,
    params.keyLength,
  ) as Uint8Array<ArrayBuffer>;

  masterKeyBytes.fill(0);

  return crypto.subtle.importKey(
    'raw',
    wrappingKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── Recovery Key derivation ───────────────────────────────────────────────────

/**
 * Derives an AES-GCM-256 wrapping key from the Recovery Key bytes via Argon2id → HKDF.
 * Used to encrypt/decrypt the emergency recovery MBK blob.
 */
export async function deriveMbkFromRecoveryKey(
  recoveryKeyBytes: Uint8Array,
  params: Argon2idHkdfParams,
): Promise<{ mbkWrappingKeyBytes: Uint8Array; mbkWrappingKey: CryptoKey }> {
  const argon2SaltBytes = b64Decode(params.argon2Salt);
  const hkdfSaltBytes   = b64Decode(params.hkdfSalt);
  const hkdfInfoBytes   = new TextEncoder().encode(params.hkdfInfo);

  const masterKeyBytes = await argon2idAsync(recoveryKeyBytes, argon2SaltBytes, {
    t:     params.argon2Iterations,
    m:     params.argon2Memory,
    p:     params.argon2Parallelism,
    dkLen: params.argon2KeyLength,
  });

  const mbkWrappingKeyBytes = hkdf(
    sha256,
    masterKeyBytes,
    hkdfSaltBytes,
    hkdfInfoBytes,
    params.keyLength,
  ) as Uint8Array<ArrayBuffer>;

  masterKeyBytes.fill(0);

  const mbkWrappingKey = await crypto.subtle.importKey(
    'raw',
    mbkWrappingKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return { mbkWrappingKeyBytes: mbkWrappingKeyBytes as Uint8Array, mbkWrappingKey };
}

// ── MBK encrypt / decrypt ─────────────────────────────────────────────────────

/**
 * Encrypts the raw MBK bytes with the wrapping key derived from PIN or Recovery Key.
 * Returns a JSON-serializable blob stored on the backend.
 */
export async function encryptMbk(
  wrappingKey: CryptoKey,
  mbkBytes:    Uint8Array<ArrayBuffer>,
): Promise<MbkEncryptedBlob> {
  const iv           = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    mbkBytes,
  );
  return {
    iv:   b64Encode(iv),
    data: b64Encode(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Decrypts the MBK blob using the wrapping key derived from PIN or Recovery Key.
 * Throws a DOMException if the key or blob is invalid.
 */
export async function decryptMbk(
  wrappingKey:    CryptoKey,
  encryptedBlob:  MbkEncryptedBlob,
): Promise<Uint8Array> {
  const iv          = b64Decode(encryptedBlob.iv);
  const cipherBytes = b64Decode(encryptedBlob.data);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    cipherBytes,
  );
  return new Uint8Array(plainBuffer);
}

// ── Sync data encrypt / decrypt ───────────────────────────────────────────────

/**
 * Encrypts a SyncPayload with the MBK (AES-GCM-256).
 * A fresh 12-byte IV is generated per item.
 */
export async function encryptForSync(
  mbk:   CryptoKey,
  plain: SyncPayload,
): Promise<EncryptedSyncPayload> {
  const iv           = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const plainBytes   = new TextEncoder().encode(JSON.stringify(plain));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    mbk,
    plainBytes,
  );
  return {
    encryptionVersion: 1,
    cacheVersion:      2,
    iv:                b64Encode(iv),
    data:              b64Encode(new Uint8Array(cipherBuffer)),
  };
}

/**
 * Decrypts an EncryptedSyncPayload with the MBK.
 * Throws if the key or payload is invalid.
 */
export async function decryptFromSync(
  mbk:     CryptoKey,
  payload: EncryptedSyncPayload,
): Promise<SyncPayload> {
  const iv          = b64Decode(payload.iv);
  const cipherBytes = b64Decode(payload.data);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    mbk,
    cipherBytes,
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer)) as SyncPayload;
}
