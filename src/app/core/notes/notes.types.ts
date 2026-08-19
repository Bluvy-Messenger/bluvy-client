export const NOTE_COLLECTION = 'app.bluvy.note';
export const CURRENT_NOTE_SCHEMA_VERSION = 1;
export const NOTE_ENCRYPTION_ALGORITHM = 'AES-256-GCM';

/**
 * Record structure as stored in the user's ATProto PDS repository.
 * Contains only encrypted ciphertext and envelope metadata.
 */
export interface BluvyNoteRecord {
  $type: typeof NOTE_COLLECTION;
  version: number;
  algorithm: string;
  ciphertext: string;
  nonce: string;
  keyGeneration: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Decrypted note plaintext content (never leaves the client unencrypted).
 */
export interface NotePlaintext {
  text: string;
  tags?: string[];
  pinned?: boolean;
  color?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Encrypted payload envelope prepared for ATProto PDS record creation/update.
 */
export interface EncryptedNoteEnvelope {
  ciphertext: string;
  nonce: string;
  keyGeneration: number;
  version: number;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
}

export type NoteSyncStatus = 'synced' | 'pending_upload' | 'pending_delete' | 'error';

/**
 * Full in-memory and local cache model representing a personal note item.
 */
export interface NoteItem {
  id: string; // ATProto record key (rkey / TID)
  cid?: string;
  text: string;
  tags: string[];
  pinned: boolean;
  color?: string;
  keyGeneration: number;
  createdAt: number; // Unix timestamp ms
  updatedAt: number; // Unix timestamp ms
  syncStatus: NoteSyncStatus;
  error?: string;
}

export interface NoteListResult {
  notes: NoteItem[];
  cursor?: string;
  hasMore: boolean;
}
