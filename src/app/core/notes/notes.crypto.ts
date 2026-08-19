import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CURRENT_NOTE_SCHEMA_VERSION,
  NOTE_ENCRYPTION_ALGORITHM,
  type BluvyNoteRecord,
  type EncryptedNoteEnvelope,
  type NotePlaintext,
} from './notes.types';

// ── Base64 conversion helpers ──────────────────────────────────────────────────

function b64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64Decode(str: string): Uint8Array<ArrayBuffer> {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Key Derivation ─────────────────────────────────────────────────────────────

const NOTES_HKDF_SALT = new TextEncoder().encode('bluvy-notes-salt-v1');
const NOTES_HKDF_INFO = new TextEncoder().encode('app.bluvy.note.encryption.v1');

/**
 * Derives the Personal Notes Key (PNK) deterministically from the Master Backup Key (MBK).
 * The derived key is imported into WebCrypto as a non-extractable AES-GCM-256 CryptoKey.
 */
export async function derivePersonalNotesKey(
  mbkBytes: Uint8Array<ArrayBuffer> | Uint8Array,
): Promise<CryptoKey> {
  const derivedKeyBytes = hkdf(
    sha256,
    mbkBytes,
    NOTES_HKDF_SALT,
    NOTES_HKDF_INFO,
    32, // 256 bits
  ) as Uint8Array<ArrayBuffer>;

  const pnk = await crypto.subtle.importKey(
    'raw',
    derivedKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false, // extractable: false — prevents key material from leaving WebCrypto
    ['encrypt', 'decrypt'],
  );

  derivedKeyBytes.fill(0);
  return pnk;
}

// ── Encryption / Decryption ───────────────────────────────────────────────────

/**
 * Encrypts a NotePlaintext using AES-256-GCM with a fresh 12-byte IV per note.
 * Returns the encrypted record envelope ready for ATProto PDS upload.
 */
export async function encryptNotePayload(
  key: CryptoKey,
  plain: NotePlaintext,
  keyGeneration: number,
  existingCreatedAt?: string,
): Promise<EncryptedNoteEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
  const plainBytes = new TextEncoder().encode(JSON.stringify(plain));

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBytes,
  );

  const nowIso = new Date().toISOString();
  return {
    version: CURRENT_NOTE_SCHEMA_VERSION,
    algorithm: NOTE_ENCRYPTION_ALGORITHM,
    ciphertext: b64Encode(new Uint8Array(cipherBuffer)),
    nonce: b64Encode(iv),
    keyGeneration,
    createdAt: existingCreatedAt ?? nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Decrypts a BluvyNoteRecord or EncryptedNoteEnvelope using AES-256-GCM.
 * Validates the authentication tag automatically (throws DOMException on forgery/corruption).
 */
export async function decryptNotePayload(
  key: CryptoKey,
  envelope: BluvyNoteRecord | EncryptedNoteEnvelope,
): Promise<NotePlaintext> {
  const iv = b64Decode(envelope.nonce);
  const cipherBytes = b64Decode(envelope.ciphertext);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes,
  );

  const jsonStr = new TextDecoder().decode(plainBuffer);
  return JSON.parse(jsonStr) as NotePlaintext;
}
