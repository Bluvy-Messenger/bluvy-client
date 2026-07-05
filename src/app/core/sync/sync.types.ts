// ── Algorithms ────────────────────────────────────────────────────────────────

export type KdfAlgorithm = 'argon2id_hkdf';

// ── KDF parameters ────────────────────────────────────────────────────────────

export interface Argon2idHkdfParams {
  argon2Salt:        string;   // base64, 32 bytes
  argon2Memory:      number;
  argon2Iterations:  number;
  argon2Parallelism: number;
  argon2KeyLength:   32;
  hkdfSalt:          string;   // base64, 32 bytes
  hkdfInfo:          'bluvy-sync-pin-v1' | 'bluvy-sync-recovery-v1';
  hashAlgorithm:     'sha256';
  keyLength:         32;
}

// ── MBK blob (stored on backend, returned by GET /v1/sync/mbk) ───────────────

export interface MbkEncryptedBlob {
  iv:   string;   // base64, 12 bytes
  data: string;   // base64: AES-GCM-256(wrappingKey, mbkBytes)
}

export interface MbkBlob {
  encryptedMbk: MbkEncryptedBlob;
  kdfAlgorithm: KdfAlgorithm;
  kdfParams:    Argon2idHkdfParams;
}

// ── Sync settings (GET /v1/sync/settings) ─────────────────────────────────────

export interface SyncSettings {
  hasMbk:         boolean;
  hasLegacyBackup: boolean;
  setupAt:         number | null;
  lastSyncAt:      number | null;
}

// ── Encrypted sync payload ────────────────────────────────────────────────────

export interface EncryptedSyncPayload {
  encryptionVersion: number;
  cacheVersion:      number;
  iv:                string;   // base64, 12 bytes
  data:              string;   // base64: AES-GCM-256(mbk, JSON(SyncPayload))
}

// ── Plaintext payload types ───────────────────────────────────────────────────

export interface SyncMessagePlaintext {
  schemaVersion:  1;
  type:           'message';
  plaintext:      string;
  conversationId: string;
  messageId:      string;
  createdAt:      number;
  senderDid?:     string;
}

export interface SyncGroupStatePlaintext {
  schemaVersion:  1;
  type:           'group-state';
  conversationId: string;
  groupState:     string;
}

export type SyncPayload = SyncMessagePlaintext | SyncGroupStatePlaintext;

// ── Pending sync queue ────────────────────────────────────────────────────────

export interface PendingSyncItem {
  messageId:      string;
  conversationId: string;
  plaintext:      string;
  createdAt:      number;
  senderDid:      string;
  keyVersion:     1;
  entryType?:     'message' | 'group-state';
}

// ── Setup result ──────────────────────────────────────────────────────────────

export interface SyncSetupResult {
  recoveryKey: string;   // Base58, 32 bytes — display once
}

// ── Progress ──────────────────────────────────────────────────────────────────

export interface BackfillProgress {
  total:    number;
  uploaded: number;
  done:     boolean;
}

export interface RestoreProgress {
  downloaded: number;
  restored:   number;
  done:       boolean;
  error?:     string;
}

export interface RebuildProgress {
  phase:    'deleting' | 'uploading' | 'done';
  uploaded: number;
  total:    number;
  done:     boolean;
  error?:   string;
}

// ── API input ─────────────────────────────────────────────────────────────────

export interface SyncDataInput {
  conversationId:    string;
  messageId:         string;
  encryptedPayload:  EncryptedSyncPayload;
  encryptionVersion: number;
  cacheVersion:      number;
  keyVersion:        1;
  createdAt:         number;
  entryType?:        'message' | 'group-state';
}

// ── Restore result ────────────────────────────────────────────────────────────

export interface RestoreResult {
  restoredMessages:    number;
  restoredGroupStates: Record<string, string>;
}
