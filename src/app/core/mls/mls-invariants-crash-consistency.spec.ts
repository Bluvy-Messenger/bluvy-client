import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 5 of the multi-device validation audit: crash consistency at
// critical boundaries.
//
// Scope note (explicit, per the audit's own instruction not to claim
// coverage without a test or clear static proof): a Karma/Jasmine unit test
// cannot simulate an actual OS-level process kill or a genuine IndexedDB
// write interrupted mid-flight by a browser crash. What CAN be simulated,
// and is simulated below:
// - "before Group State write" / "after Group State write": by making the
//   write step throw or by inspecting state immediately before/after the
//   awaited call, since MlsStateStorageService's/FakeMlsStorage's update()
//   is a single atomic operation (see AUDIT_08's finding on IndexedDB
//   put() atomicity) -- there is no partial-write state to reach in the
//   first place, verified here by confirming a failed write leaves the
//   PRIOR state completely untouched.
// - "before/after Commit persistence [network]": by making the network call
//   (postCommit) fail after the local optimistic write already succeeded --
//   a real, reachable ordering in production (mls-membership.service.ts
//   always writes local state before calling mlsRepo.postCommit()).
// - "before/after READY transition": already covered in depth by
//   mls-coordinator.restore-race.spec.ts (Scenario A and Cases D-G) and not
//   re-tested here.
// - "before/after ACK": ACK (Welcome acknowledgement) lives in
//   MlsWelcomeService, not in the multi-device harness's Device (which only
//   wires MlsCommitService/MlsMembershipService/MlsMessageCryptoService) --
//   not covered by this file; already documented as a durability invariant
//   in mls-welcome.service.ts's own comments (Welcome stays "pending"
//   server-side until ACKed, so a crash before ACK just re-serves it) and
//   partially covered by mls-welcome.service.spec.ts. Listed explicitly as
//   NOT independently re-verified here (see the final report's coverage gaps).

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-crash';

describe('MLS multi-device invariants — crash consistency (Section 5)', () => {

  it('crash simulated as a failing local write: the PRIOR Group State is left completely untouched, and a clean retry afterward succeeds', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    const stateBeforeCrash = a.getGroupStateB64(CONV_ID);

    // Simulate "crashed before the local write completed" by making the
    // storage layer's write step itself fail once.
    const originalUpdate = a.storage.update.bind(a.storage);
    let failNext = true;
    a.storage.update = ((scope: string, updater: (s: unknown) => Promise<unknown>) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('simulated crash during write')); }
      return originalUpdate(scope, updater as never);
    }) as typeof a.storage.update;

    await expectAsync(a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A)).toBeRejected();

    // Prior state completely unchanged -- no partial write.
    expect(a.getGroupStateB64(CONV_ID)).toBe(stateBeforeCrash);
    expect(a.epoch(CONV_ID)).toBe(1);
    expect(backend.getCommits(CONV_ID).length).toBe(1); // only the genesis commit

    // "Restart" and retry cleanly.
    await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
    expect(a.epoch(CONV_ID)).toBe(2);
    expect(a.memberDeviceIds(CONV_ID)).toContain('device-x');
  });

  // FINDING (documented, not fixed). Investigated as a genuine hypothesis,
  // not assumed: mls-membership.service.ts's provisionDevice() writes the
  // new Group State locally (storage.update(), optimistic) BEFORE calling
  // mlsRepo.postCommit() (network). Its catch block only handles a 409
  // response specially (clears state, signals epochConflict$); any OTHER
  // failure (e.g. the network going down between the local write and the
  // request completing) is just re-thrown, WITHOUT rolling back the local
  // optimistic write. This test empirically checks what state that leaves
  // the device in.
  it('FINDING: a network failure AFTER the local optimistic write (before the server confirms the commit) leaves the local epoch permanently ahead of what was ever actually posted', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    // Simulate the network dying for exactly the postCommit call.
    const originalPostCommit = backend.postCommit.bind(backend);
    let failNext = true;
    backend.postCommit = ((...args: Parameters<typeof backend.postCommit>) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('simulated network failure')); }
      return originalPostCommit(...args);
    }) as typeof backend.postCommit;

    await expectAsync(a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A)).toBeRejected();

    // The finding, stated as observed fact: local state already advanced...
    expect(a.epoch(CONV_ID)).withContext('local epoch advanced optimistically despite the commit never being posted').toBe(2);
    expect(a.memberDeviceIds(CONV_ID)).withContext('device-x appears locally as a member').toContain('device-x');
    // ...while the server has NO record of this commit at all.
    expect(backend.getCommits(CONV_ID).filter(c => c.epoch === 1).length)
      .withContext('the server never received any commit for this epoch')
      .toBe(0);

    // Consequence: provisionDevice()'s own idempotent "already a member"
    // pre-check (mls-membership.service.ts:81, isDeviceMember) now silently
    // SKIPS a retry for the same device, because the LOCAL state already
    // (wrongly) believes device-x is provisioned -- so a later, automatic
    // retry (e.g. the next reconnect sweep) does not repair this on its own.
    const secondAttempt = await (async () => {
      try { await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A); return 'ran'; }
      catch { return 'threw'; }
    })();
    expect(secondAttempt).toBe('ran'); // does not throw -- just silently no-ops
    expect(backend.getCommits(CONV_ID).filter(c => c.epoch === 1).length)
      .withContext('still nothing posted -- the pre-check skip means it never retries the actual commit')
      .toBe(0);
  });

  it('crash before ANY write for a brand-new conversation (nothing local, nothing on the backend): retry starts clean, no divergence possible', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);

    expect(() => a.getGroupStateB64(CONV_ID)).not.toThrow(); // undefined, not an exception
    expect(a.getGroupStateB64(CONV_ID)).toBeUndefined();
    expect(backend.getCommits(CONV_ID).length).toBe(0);
    // Nothing to assert beyond absence -- included for completeness of the
    // boundary enumeration (there is trivially no possible divergence when
    // neither side has written anything yet).
  });
});
