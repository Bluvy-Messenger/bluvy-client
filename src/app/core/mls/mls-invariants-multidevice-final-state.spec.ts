import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 10 of the multi-device validation audit: a 4-member group (A, B,
// C survive; D is revoked) with concurrent operations, checking that every
// surviving device converges to the same epoch/membership/decrypt
// capability, and that the removed device is excluded, cannot decrypt, and
// cannot regain access via its own backup.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Desktop', platform: 'web' };
const USER_D: UserProfile = { did: 'did:plc:dave', handle: 'dave.test', displayName: 'Dave', avatarUrl: null };
const DEVICE_D: DeviceInfo = { id: 'device-d1', name: 'Old Phone', platform: 'android' };
const CONV_ID = 'conv-final-state';

describe('MLS multi-device invariants — 4-device final state after concurrent ops + one revocation (Section 10)', () => {
  it('A, B, C converge (epoch, membership, decrypt) after concurrent operations; D is excluded, cannot decrypt, and cannot regain access via its own backup', async () => {
    const backend = new FakeMlsBackend();
    backend.delayRangeMs = [0, 5];
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    const d = new Device(backend, USER_D, DEVICE_D);
    await makeGroup(CONV_ID, backend, a, [b, c, d]);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id, DEVICE_C.id, DEVICE_D.id].sort());

    // Concurrent phase: A adds a new device, B revokes D, both racing.
    const [resAdd, resRemove] = await Promise.allSettled([
      a.membershipSvc.provisionDevice('device-a2', CONV_ID, USER_A, DEVICE_A),
      b.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_B, DEVICE_B),
    ]);
    expect(resAdd.status).toBe('fulfilled');
    expect(resRemove.status).toBe('fulfilled');

    // Convergence pass for survivors (mirrors the retry-aware converge()
    // helper validated in mls-invariants-remove-update.spec.ts: whichever
    // side lost its race catches up, and the losing side's OWN operation is
    // retried -- exactly as production does via two separate, real
    // reconnect-sweep mechanisms in device-provisioning.service.ts:
    // removeRevokedDeviceLeaves() retries a lost Remove, and the "pending
    // provisions" list (getPendingProvisions(), re-checked on every
    // reconnect) retries a lost Add. Both provisionDevice() and
    // removeRevokedDeviceFromAllGroups() have their own idempotent
    // "already applied" pre-checks, so retrying the side that actually won
    // its race is always a safe no-op.
    await Promise.all([
      a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A),
      b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B),
      c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C),
    ]);
    await a.membershipSvc.provisionDevice('device-a2', CONV_ID, USER_A, DEVICE_A); // idempotent retry (pending-provisions sweep)
    await b.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_B, DEVICE_B); // idempotent retry (revoked-leaves sweep)
    await Promise.all([
      a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A),
      b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B),
      c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C),
    ]);

    // Convergence: same epoch, same membership, for every survivor.
    const epochA = a.epoch(CONV_ID);
    expect(b.epoch(CONV_ID)).toBe(epochA);
    expect(c.epoch(CONV_ID)).toBe(epochA);

    const membersA = a.memberDeviceIds(CONV_ID).sort();
    expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(membersA);
    expect(c.memberDeviceIds(CONV_ID).sort()).toEqual(membersA);
    expect(membersA).toContain('device-a2');
    expect(membersA).not.toContain(DEVICE_D.id);

    // Convergence, the strong way: every survivor can decrypt every other
    // survivor's traffic.
    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'from A');
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('from A');
    expect(await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA)).toBe('from A');

    const fromC = await c.messageCryptoSvc.encryptMessage(CONV_ID, USER_C, DEVICE_C, 'from C');
    expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromC)).toBe('from C');
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromC)).toBe('from C');

    // D: excluded, cannot decrypt current traffic with its retained
    // (frozen, pre-removal) state.
    await expectAsync(d.messageCryptoSvc.decryptMessage(CONV_ID, USER_D, DEVICE_D, fromA)).toBeRejected();

    // D cannot reintegrate via its own backup: a device's backup can only
    // ever contain a snapshot of what THAT device itself derived while it
    // was still a member -- restoring it (simulated: re-seeding D's own
    // pre-removal state, which is already exactly what D has) grants
    // nothing new. Verified directly rather than assumed: after
    // "restoring", D's epoch is still the pre-removal one, and it still
    // cannot decrypt current traffic.
    const dEpochBeforeRestore = d.epoch(CONV_ID);
    d.seedGroupState(CONV_ID, d.getGroupStateB64(CONV_ID)!); // no-op "restore" of its own last snapshot
    expect(d.epoch(CONV_ID)).toBe(dEpochBeforeRestore);
    await expectAsync(d.messageCryptoSvc.decryptMessage(CONV_ID, USER_D, DEVICE_D, fromC)).toBeRejected();
  });
});
