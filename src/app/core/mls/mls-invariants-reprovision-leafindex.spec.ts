import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Regression suite for the reprovisionLostStateDevice() leafIndex mapping
// bug (mls-membership.service.ts), same root cause as the already-fixed
// double-Remove bug: members.findIndex(...) on getGroupMembers()'s
// COMPACTED array was treated as a real MLS leaf index. Confirmed
// experimentally before this fix (see the investigation this file replaces)
// that Scenario 2 below silently removed C instead of D and left D with two
// leaves in the tree -- no exception, no membership-list-only check would
// have caught it. Fixed the same way as the double-Remove bug: ts-mls's own
// findLeafIndex() (ts-mls/ratchetTree.js), which resolves the true leaf
// index directly from the raw ratchetTree by matching the LeafNode itself.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet', platform: 'web' };
const USER_D: UserProfile = { did: 'did:plc:dave', handle: 'dave.test', displayName: 'Dave', avatarUrl: null };
const DEVICE_D: DeviceInfo = { id: 'device-d1', name: 'Old Phone', platform: 'android' };
const CONV_ID = 'conv-reprovision-leafindex';

describe('MLS multi-device invariants — reprovisionLostStateDevice() leafIndex mapping correction', () => {

  it('Scenario 1: A+B+C, Remove(B), reprovisionLostStateDevice(C) -- C is correctly the target', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);

    await a.membershipSvc.reprovisionLostStateDevice(DEVICE_C.id, CONV_ID, USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_C.id].sort());
  });

  it('Scenario 2 (CRITICAL): A+B+C+D, Remove(B), reprovisionLostStateDevice(D) -- D is the target, C MUST remain a member, no other device is removed', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    const d = new Device(backend, USER_D, DEVICE_D);
    await makeGroup(CONV_ID, backend, a, [b, c, d]);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);

    const membersBefore = a.memberDeviceIds(CONV_ID).sort();
    expect(membersBefore).toEqual([DEVICE_A.id, DEVICE_C.id, DEVICE_D.id].sort());

    await a.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_A, DEVICE_A);

    const membersAfter = a.memberDeviceIds(CONV_ID);
    // Exactly A, C, D -- no duplicate D leaf, no silently-removed C.
    expect(membersAfter.sort()).toEqual([DEVICE_A.id, DEVICE_C.id, DEVICE_D.id].sort());
    expect(membersAfter.filter(id => id === DEVICE_D.id).length).withContext('D must have exactly one leaf, not two').toBe(1);
    expect(membersAfter).withContext('C must not have been silently removed').toContain(DEVICE_C.id);
  });

  it('Scenario 3: A+B+C+D, Remove(B), Remove(C), reprovisionLostStateDevice(D) -- D is the target, A remains a member, D is correctly reprovisioned', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    const d = new Device(backend, USER_D, DEVICE_D);
    await makeGroup(CONV_ID, backend, a, [b, c, d]);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

    await a.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_A, DEVICE_A);

    const membersAfter = a.memberDeviceIds(CONV_ID);
    expect(membersAfter).withContext('A must remain a member').toContain(DEVICE_A.id);
    expect(membersAfter.filter(id => id === DEVICE_D.id).length).withContext('D correctly reprovisioned exactly once').toBe(1);
    expect(membersAfter.sort()).toEqual([DEVICE_A.id, DEVICE_D.id].sort());
  });

  // ── Cryptographic verification, Scenario 2 ──────────────────────────────
  // Not memberDeviceIds alone: D actually processes its real Welcome (via
  // the harness's joinViaPendingWelcome(), real ts-mls joinGroup()) to get
  // its genuine new post-reprovision session, then every survivor's real
  // decrypt capability is checked, specifically confirming C did NOT lose
  // access as a side effect of D's reprovisioning.
  it('Scenario 2 cryptographic verification: A/C/D decrypt=SUCCESS (D with its new session), B decrypt=FAILURE', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    const d = new Device(backend, USER_D, DEVICE_D);
    await makeGroup(CONV_ID, backend, a, [b, c, d]);

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);
    await c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C);

    await a.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_A, DEVICE_A);
    await c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C);

    // D processes its real Welcome to get its genuine new session -- not a
    // simulated/assumed state.
    await d.joinViaPendingWelcome(CONV_ID);

    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_C.id, DEVICE_D.id].sort());
    expect(c.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());
    expect(d.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());

    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'to survivors and reprovisioned D');

    const plaintextC = await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA);
    expect(plaintextC).withContext('C decrypt must SUCCEED -- C must not have lost access to D\'s reprovisioning').toBe('to survivors and reprovisioned D');

    const plaintextD = await d.messageCryptoSvc.decryptMessage(CONV_ID, USER_D, DEVICE_D, fromA);
    expect(plaintextD).withContext('D decrypt must SUCCEED, using its genuine new post-reprovision session').toBe('to survivors and reprovisioned D');

    // A's own decrypt of a message from a survivor, for completeness.
    const fromC = await c.messageCryptoSvc.encryptMessage(CONV_ID, USER_C, DEVICE_C, 'from C');
    const plaintextA = await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromC);
    expect(plaintextA).withContext('A decrypt must SUCCEED').toBe('from C');

    // B was removed -- must not be able to decrypt anything encrypted afterward.
    await expectAsync(
      b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA),
    ).withContext('B decrypt must FAIL -- B was removed before D\'s reprovisioning').toBeRejected();
  });
});
