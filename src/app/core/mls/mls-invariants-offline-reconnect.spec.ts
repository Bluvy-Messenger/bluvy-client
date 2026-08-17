import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 8 of the multi-device validation audit: offline / reconnect.
//
// Overlap note: "offline, misses N commits, single reconnect catches up N
// epochs" is already proven by mls-invariants-epoch-fuzzing.spec.ts's
// 9-epoch-gap test and mls-invariants-idempotence.spec.ts's
// catchUpMissedCommits tests -- not re-duplicated here. This file covers
// what those don't: MULTIPLE independent offline/reconnect CYCLES in a row
// (not one single gap), and offline-around-a-commit-it-itself-sent.
//
// Not covered by this file (multi-device harness has no MlsWelcomeService/
// SyncService wiring -- see mls-multidevice-harness.ts's doc comment):
// "offline during Welcome" and "offline during Restore". Welcome's own
// offline-safety is a durability property already covered by
// mls-welcome.service.spec.ts and documented in AUDIT_08 Partie 11 (a
// Welcome stays "pending" server-side until ACKed, so it is re-served
// regardless of when the device reconnects). Restore's is covered at the
// coordinator level by mls-coordinator.restore-race.spec.ts's Scenario A/B.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-offline';

describe('MLS multi-device invariants — offline / reconnect (Section 8)', () => {

  it('multiple independent offline/reconnect cycles (not one single gap): each catch-up only applies what it actually missed, no re-application, no loss', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    for (let cycle = 0; cycle < 5; cycle++) {
      // B "goes offline": simply does nothing while A posts a commit.
      await a.membershipSvc.provisionDevice(`device-cycle-${cycle}`, CONV_ID, USER_A, DEVICE_A);

      // B "reconnects": catches up.
      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).withContext(`cycle ${cycle}`).toBe(1); // exactly the one commit missed this cycle, not more

      expect(b.epoch(CONV_ID)).withContext(`cycle ${cycle}`).toBe(a.epoch(CONV_ID));
      expect(b.memberDeviceIds(CONV_ID).sort()).withContext(`cycle ${cycle}`).toEqual(a.memberDeviceIds(CONV_ID).sort());
    }

    // Final convergence proof: real round-trip after 5 offline/reconnect cycles.
    const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'after 5 offline cycles');
    const plaintext  = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
    expect(plaintext).toBe('after 5 offline cycles');
  });

  it('offline immediately after posting its own commit (before any peer could have caught up): reconnecting peers still catch up correctly once the network returns', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    // A posts a commit then "goes offline" -- nothing more to simulate on
    // A's side, since the commit is already durably stored server-side the
    // moment postCommit() resolves (bluvy-backend's storeMlsCommit, proven
    // server-side); A's own subsequent offline-ness cannot un-post it.
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);

    // B was offline the whole time and only now reconnects.
    const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    expect(applied).toBe(1);
    expect(b.epoch(CONV_ID)).toBe(a.epoch(CONV_ID));
    expect(b.memberDeviceIds(CONV_ID)).toContain('device-x');
  });

  it('offline device attempting catchUpMissedCommits with zero actual gap is a safe no-op (reconnect does not need to know in advance whether anything was missed)', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    // Nothing happened while "offline" -- B reconnects anyway (a real client
    // reconnect handler doesn't know in advance whether anything was missed).
    const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    expect(applied).toBe(0);
    expect(b.epoch(CONV_ID)).toBe(1);
  });
});
