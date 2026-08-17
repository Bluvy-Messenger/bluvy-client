import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// PERMANENT REGRESSION SUITE — P2 fix: decryptMessage() now catches up on an
// epoch-ahead ciphertext instead of misclassifying it as a permanent
// failure.
//
// Root cause (confirmed by static analysis + ts-mls source reading this
// session): ts-mls's processPrivateMessage() only special-cases a ciphertext
// epoch BEHIND the local epoch (historical key retention). A ciphertext
// epoch AHEAD of local (this device missed a later commit) fell straight
// through into the crypto call using the wrong (stale) epoch's keys,
// producing a raw browser AEAD failure (CryptoError, e.g. "OperationError:
// ...") whose .message matches none of the coordinator's
// TRANSIENT_PATTERNS/PERMANENT_PATTERNS regexes -- misclassified
// PermanentMlsError('InvalidCiphertext') on the FIRST attempt, never even
// reaching the pending_decrypt transient-retry queue, and never
// automatically retried afterward (replayPendingDecrypts() only ever reads
// from PendingDecryptRepository, never populated for an already-undecryptable
// message).
//
// FIX: MlsMessageCryptoService.decryptMessage() now detects the epoch-ahead
// condition structurally (a zero-cost bigint comparison, before any crypto
// call) and throws DecryptEpochAheadError; MlsCoordinatorService.decryptMessage()
// catches it specifically (never via regex classification) and attempts one
// catchUpMissedCommits() + retry before falling back to today's existing
// chain.
//
// Real ts-mls crypto throughout, via testing/mls-multidevice-harness.ts.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-decrypt-epoch-ahead';

describe('P2 FIX -- decryptMessage() catches up on an epoch-ahead ciphertext instead of failing permanently', () => {

  it('a message encrypted at an epoch A has not caught up to now decrypts successfully via the real coordinator, instead of becoming undecryptable', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    // Real production usage: the conversation is established as Ready via
    // ensureGroupReady() (as conversation.page.ts always does) before any
    // message ever arrives to decrypt -- matches how the coordinator's
    // internal state machine is actually reached in practice.
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    expect(a.epoch(CONV_ID)).toBe(1);

    // B advances the group by one real commit (adds a second device) while A
    // never applies it -- A is now genuinely one epoch behind.
    await b.membershipSvc.provisionDevice('device-b2', CONV_ID, USER_B, DEVICE_B);
    expect(b.epoch(CONV_ID)).toBe(2);
    expect(a.epoch(CONV_ID)).withContext('A has not caught up').toBe(1);

    // B encrypts a real message at the new epoch.
    const ciphertext = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'hello from the future epoch');

    // The REAL production entry point -- the coordinator, not the raw crypto service.
    const result = await a.coordinator.decryptMessage(
      CONV_ID, 'msg-epoch-ahead', USER_B.did, DEVICE_B.id, false, Date.now(),
      ciphertext, USER_A, DEVICE_A,
    );

    expect(result.state).withContext('FIXED: catch-up ran automatically, decrypt succeeded').toBe('plaintext');
    expect(result.plaintext).toBe('hello from the future epoch');
    expect(a.epoch(CONV_ID)).withContext('the catch-up genuinely advanced A\'s local epoch').toBe(2);
  });

  it('multiple missed commits: catch-up applies all of them in the single retry, no loop needed', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    await b.membershipSvc.provisionDevice('device-b2', CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('device-b3', CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('device-b4', CONV_ID, USER_B, DEVICE_B);
    expect(b.epoch(CONV_ID)).toBe(4);
    expect(a.epoch(CONV_ID)).toBe(1);

    const ciphertext = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'hello after three missed commits');

    const result = await a.coordinator.decryptMessage(
      CONV_ID, 'msg-multi-epoch-ahead', USER_B.did, DEVICE_B.id, false, Date.now(),
      ciphertext, USER_A, DEVICE_A,
    );

    expect(result.state).toBe('plaintext');
    expect(result.plaintext).toBe('hello after three missed commits');
    expect(a.epoch(CONV_ID)).toBe(4);
  });

  it('a message at A\'s OWN current epoch (no gap) still decrypts normally -- the new structural check does not affect the ordinary path', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    const ciphertext = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'ordinary message, no gap');
    const result = await a.coordinator.decryptMessage(
      CONV_ID, 'msg-ordinary', USER_B.did, DEVICE_B.id, false, Date.now(),
      ciphertext, USER_A, DEVICE_A,
    );

    expect(result.state).toBe('plaintext');
    expect(result.plaintext).toBe('ordinary message, no gap');
  });
});
