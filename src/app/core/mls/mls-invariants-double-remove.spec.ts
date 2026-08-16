import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Targeted correction validation for the P0 bug found by the property-based
// suite (seed=17): mls-membership.service.ts's removeRevokedDeviceFromAllGroups()
// used getGroupMembers()'s COMPACTED array position as if it were the real
// MLS leaf index. getGroupMembers() (ts-mls/clientState.js) filters out
// blank leaves, so its array position only equals the true leaf index while
// the tree has never had a removal yet -- as soon as one leaf is blanked, it
// shifts every later member's compacted position down by one. The fix uses
// ts-mls's own findLeafIndex() (ts-mls/ratchetTree.js), which resolves the
// true leaf index directly from the raw ratchetTree by matching the
// LeafNode itself, independent of any earlier blanks.
//
// This file covers every scenario the correction task enumerated. Real
// ts-mls crypto throughout (via testing/mls-multidevice-harness.ts) -- no
// mocked commit application.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet', platform: 'web' };
const CONV_ID = 'conv-double-remove';

describe('MLS multi-device invariants — double/triple removal correction validation', () => {

  it('1. removes a single device cleanly', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    expect(a.memberDeviceIds(CONV_ID)).not.toContain('device-x');
  });

  it('2. removes two devices successively (the original seed=17 shape)', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-y', USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
  });

  it('3. removes three devices successively', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-z', CONV_ID, USER_A, DEVICE_A);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-y', USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-z', USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
  });

  it('4. removal order does not matter -- every reasonable order converges to the same final membership', async () => {
    const orders: string[][] = [
      ['device-x', 'device-y', 'device-z'],
      ['device-z', 'device-y', 'device-x'],
      ['device-y', 'device-x', 'device-z'],
      ['device-z', 'device-x', 'device-y'],
    ];

    for (const order of orders) {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
      await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);
      await a.membershipSvc.provisionDevice('device-z', CONV_ID, USER_A, DEVICE_A);

      for (const target of order) {
        await a.membershipSvc.removeRevokedDeviceFromAllGroups(target, USER_A, DEVICE_A);
      }

      expect(a.memberDeviceIds(CONV_ID).sort())
        .withContext(`order ${JSON.stringify(order)}`)
        .toEqual([DEVICE_A.id, DEVICE_B.id].sort());
    }
  });

  it('5. removes the FIRST member added, then the LAST member added', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    // 4-member group at founding: A (founder), B, C, plus one more added below.
    await makeGroup(CONV_ID, backend, a, [b, c]);
    await a.membershipSvc.provisionDevice('device-last', CONV_ID, USER_A, DEVICE_A);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(
      [DEVICE_A.id, DEVICE_B.id, DEVICE_C.id, 'device-last'].sort(),
    );

    // First member added chronologically after the founder is B (joined via
    // makeGroup); remove it, then remove the very last one added.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-last', USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_C.id].sort());
  });

  it('6. removing an already-removed device is an idempotent no-op, including after another removal happened in between', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    const epochAfterFirst = a.epoch(CONV_ID);

    // Re-removing the already-gone device-x must not throw and must not
    // advance the epoch (shouldSkip path, leafIndex undefined).
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    expect(a.epoch(CONV_ID)).toBe(epochAfterFirst);

    // A different, still-present device is removed in between...
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-y', USER_A, DEVICE_A);
    const epochAfterSecond = a.epoch(CONV_ID);

    // ...and re-removing device-x again (now doubly stale) still safely no-ops.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    expect(a.epoch(CONV_ID)).toBe(epochAfterSecond);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
  });

  it('7. removing a device that was never a member is a safe no-op', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    const epochBefore = a.epoch(CONV_ID);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-never-existed', USER_A, DEVICE_A);

    expect(a.epoch(CONV_ID)).toBe(epochBefore);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
  });

  it('8. removes correctly after several unrelated epoch advances (Add/Update commits) happened first', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);

    // First removal blanks a leaf.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);

    // Several unrelated epoch advances afterward (more Adds).
    await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-z', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-w', CONV_ID, USER_A, DEVICE_A);

    // Removing one of the LATER-added devices must still resolve its real
    // leaf index correctly, despite the tree having accumulated both a
    // blank (from device-x) and several new leaves since.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-z', USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(
      [DEVICE_A.id, DEVICE_B.id, 'device-y', 'device-w'].sort(),
    );
  });

  it('Étape 3 exact scenario: A+B+C+D, Remove(B), Remove(D), Remove(C)', async () => {
    const DEVICE_D: DeviceInfo = { id: 'device-d1', name: 'Old Phone', platform: 'android' };
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    const d = new Device(backend, { did: 'did:plc:dave', handle: 'dave.test', displayName: 'Dave', avatarUrl: null }, DEVICE_D);
    await makeGroup(CONV_ID, backend, a, [b, c, d]);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(
      [DEVICE_A.id, DEVICE_B.id, DEVICE_C.id, DEVICE_D.id].sort(),
    );

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id].sort());
  });

  // ── Étape 5: cryptographic verification, exact scenario ────────────────
  it('Étape 5 exact scenario: A+B+C, Remove(C) at epoch N, message at epoch N+1 -- A decrypt=SUCCESS, B decrypt=SUCCESS, C decrypt=FAILURE', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);

    const epochN = a.epoch(CONV_ID);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

    expect(a.epoch(CONV_ID)).toBe(epochN + 1);
    expect(b.epoch(CONV_ID)).toBe(epochN + 1);
    expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);

    const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-revocation message');

    const plaintextB = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
    expect(plaintextB).withContext('B decrypt must SUCCEED').toBe('post-revocation message');

    await expectAsync(
      c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, ciphertext),
    ).withContext('C decrypt must FAIL').toBeRejected();

    // A's own view: re-encrypt/decrypt round trip for completeness (A decrypt=SUCCESS).
    const ciphertextB = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'from B after revocation');
    const plaintextA = await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, ciphertextB);
    expect(plaintextA).withContext('A decrypt must SUCCEED').toBe('from B after revocation');
  });

  it('double removal + real membership verification: after Remove(x) then Remove(z), memberDeviceIds matches the real ts-mls tree exactly on both A and B', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.provisionDevice('device-z', CONV_ID, USER_A, DEVICE_A);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-x', USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-z', USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

    const membersA = a.memberDeviceIds(CONV_ID).sort();
    const membersB = b.memberDeviceIds(CONV_ID).sort();
    expect(membersA).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
    expect(membersB).toEqual(membersA);
  });

  // Étape 7: Remove(B) + Remove(C), both issued by the SAME device A,
  // concurrently. The architecture has no per-conversation client-side lock
  // preventing two calls from the same device instance running at once --
  // correctness instead falls out of MlsStateStorageService's per-scope
  // serialization: the second call's storage.update() cannot even begin
  // (let alone compute a leaf index or an epoch to post) until the first
  // call's ENTIRE local update -- including its real ts-mls createCommit()
  // work, not just a queue wait -- has finished. That gives the first call's
  // network postCommit() a head start larger, in practice, than the random
  // jitter applied per network call here, so the two commits' declared
  // epochs are always posted in the same order they were locally computed.
  // Verified empirically (not assumed): 1 zero-delay run + 20 runs with
  // randomized 0-15ms delay on every network call (acquireCommitLock AND
  // postCommit independently) all converged correctly with no
  // EPOCH_GAP/409 and no destructive clearConversationGroup reset.
  it('Étape 7: Remove(B) + Remove(C) issued concurrently by the same device converge correctly under randomized network jitter (20 repetitions)', async () => {
    for (let i = 0; i < 20; i++) {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 15];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      const results = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A),
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A),
      ]);

      expect(results.every(r => r.status === 'fulfilled'))
        .withContext(`iteration ${i}: ${JSON.stringify(results.map(r => r.status === 'rejected' ? String(r.reason) : 'ok'))}`)
        .toBe(true);
      expect(a.getGroupStateB64(CONV_ID))
        .withContext(`iteration ${i}: local group state must not have been destructively cleared`)
        .toBeDefined();
      expect(a.memberDeviceIds(CONV_ID))
        .withContext(`iteration ${i}`)
        .toEqual([DEVICE_A.id]);
    }
  }, 30000);
});
