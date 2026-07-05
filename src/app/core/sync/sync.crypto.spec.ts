import { decryptFromSync, decryptMbk, encryptForSync, encryptMbk, importMbk } from './sync.crypto';
import type { SyncPayload } from './sync.types';

// Helpers
async function makeKey(): Promise<CryptoKey> {
  const bytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
  return importMbk(bytes);
}

describe('importMbk', () => {
  it('returns an AES-GCM CryptoKey', async () => {
    const key = await makeKey();
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.type).toBe('secret');
  });

  it('allows encrypt and decrypt usages', async () => {
    const key = await makeKey();
    expect(key.usages).toContain('encrypt');
    expect(key.usages).toContain('decrypt');
  });
});

describe('encryptMbk / decryptMbk', () => {
  it('roundtrips MBK bytes', async () => {
    const wrappingKey = await makeKey();
    const original = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const blob = await encryptMbk(wrappingKey, original);
    const recovered = await decryptMbk(wrappingKey, blob);
    expect(recovered).toEqual(original);
  });

  it('produces different ciphertexts each call (random IV)', async () => {
    const wrappingKey = await makeKey();
    const bytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const blob1 = await encryptMbk(wrappingKey, bytes);
    const blob2 = await encryptMbk(wrappingKey, bytes);
    expect(blob1.iv).not.toBe(blob2.iv);
  });

  it('throws when decrypting with a wrong key', async () => {
    const key1 = await makeKey();
    const key2 = await makeKey();
    const bytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    const blob = await encryptMbk(key1, bytes);
    await expectAsync(decryptMbk(key2, blob)).toBeRejected();
  });
});

describe('encryptForSync / decryptFromSync', () => {
  it('roundtrips a SyncPayload', async () => {
    const mbk = await makeKey();
    const plain: SyncPayload = {
      schemaVersion: 1,
      type: 'message',
      conversationId: 'conv-123',
      messageId: 'msg-456',
      plaintext: 'hello world',
      senderDid: 'did:plc:alice',
      createdAt: 1700000000000,
    };
    const encrypted = await encryptForSync(mbk, plain);
    const decrypted = await decryptFromSync(mbk, encrypted);
    expect(decrypted).toEqual(plain);
  });

  it('sets encryptionVersion=1 and cacheVersion=2', async () => {
    const mbk = await makeKey();
    const plain: SyncPayload = {
      schemaVersion: 1,
      type: 'message', conversationId: 'c', messageId: 'm',
      plaintext: 'x', senderDid: 'did:plc:bob', createdAt: 0,
    };
    const encrypted = await encryptForSync(mbk, plain);
    expect(encrypted.encryptionVersion).toBe(1);
    expect(encrypted.cacheVersion).toBe(2);
  });

  it('produces different ciphertexts each call', async () => {
    const mbk = await makeKey();
    const plain: SyncPayload = {
      schemaVersion: 1,
      type: 'message', conversationId: 'c', messageId: 'm',
      plaintext: 'x', senderDid: 'did:plc:bob', createdAt: 0,
    };
    const e1 = await encryptForSync(mbk, plain);
    const e2 = await encryptForSync(mbk, plain);
    expect(e1.data).not.toBe(e2.data);
  });
});
