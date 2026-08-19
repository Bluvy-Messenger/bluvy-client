import {
  derivePersonalNotesKey,
  encryptNotePayload,
  decryptNotePayload,
} from './notes.crypto';
import type { NotePlaintext, BluvyNoteRecord } from './notes.types';

describe('NotesCrypto', () => {
  let sampleMbk: Uint8Array;
  let samplePnk: CryptoKey;

  beforeEach(async () => {
    sampleMbk = crypto.getRandomValues(new Uint8Array(32));
    samplePnk = await derivePersonalNotesKey(sampleMbk);
  });

  it('should derive a valid CryptoKey from MBK bytes', () => {
    expect(samplePnk).toBeDefined();
    expect(samplePnk.algorithm.name).toBe('AES-GCM');
    expect(samplePnk.extractable).toBeFalse();
  });

  it('should deterministically derive identical PNK from identical MBK', async () => {
    const pnk1 = await derivePersonalNotesKey(sampleMbk);
    const pnk2 = await derivePersonalNotesKey(sampleMbk);

    const testPayload: NotePlaintext = { text: 'Secret message test' };
    const enc = await encryptNotePayload(pnk1, testPayload, 1);
    const dec = await decryptNotePayload(pnk2, enc);

    expect(dec.text).toBe(testPayload.text);
  });

  it('should derive different keys from different MBKs', async () => {
    const otherMbk = crypto.getRandomValues(new Uint8Array(32));
    const otherPnk = await derivePersonalNotesKey(otherMbk);

    const testPayload: NotePlaintext = { text: 'Test isolation' };
    const enc = await encryptNotePayload(samplePnk, testPayload, 1);

    await expectAsync(decryptNotePayload(otherPnk, enc)).toBeRejected();
  });

  it('should encrypt and decrypt a note plaintext faithfully', async () => {
    const plain: NotePlaintext = {
      text: 'My personal note content with special chars: éàçü 🚀 & JSON {"nested": true}',
      tags: ['personal', 'todo'],
      pinned: true,
      color: '#ffdd00',
    };

    const encrypted = await encryptNotePayload(samplePnk, plain, 1);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.nonce).toBeDefined();
    expect(encrypted.nonce.length).toBeGreaterThan(0);
    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(encrypted.version).toBe(1);
    expect(encrypted.keyGeneration).toBe(1);

    const decrypted = await decryptNotePayload(samplePnk, encrypted);

    expect(decrypted.text).toBe(plain.text);
    expect(decrypted.tags).toEqual(plain.tags);
    expect(decrypted.pinned).toBe(true);
    expect(decrypted.color).toBe('#ffdd00');
  });

  it('should reject decryption if ciphertext is tampered with (GCM auth tag check)', async () => {
    const plain: NotePlaintext = { text: 'Authenticity test' };
    const encrypted = await encryptNotePayload(samplePnk, plain, 1);

    // Tamper with ciphertext by altering characters in base64
    const originalCipher = atob(encrypted.ciphertext);
    const tampered = originalCipher.slice(0, -2) + String.fromCharCode((originalCipher.charCodeAt(originalCipher.length - 2) ^ 1)) + originalCipher.slice(-1);
    const tamperedBase64 = btoa(tampered);

    const corruptedEnvelope = { ...encrypted, ciphertext: tamperedBase64 };

    await expectAsync(decryptNotePayload(samplePnk, corruptedEnvelope)).toBeRejected();
  });

  it('should reject decryption if nonce/IV is tampered with', async () => {
    const plain: NotePlaintext = { text: 'Nonce check' };
    const encrypted = await encryptNotePayload(samplePnk, plain, 1);

    const originalNonce = atob(encrypted.nonce);
    const tamperedNonce = String.fromCharCode((originalNonce.charCodeAt(0) ^ 1)) + originalNonce.slice(1);
    const corruptedEnvelope = { ...encrypted, nonce: btoa(tamperedNonce) };

    await expectAsync(decryptNotePayload(samplePnk, corruptedEnvelope)).toBeRejected();
  });
});
