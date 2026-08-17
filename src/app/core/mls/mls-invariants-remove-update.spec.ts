import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 3 of the multi-device validation audit — the priority security
// test: a real 3-member group (A, B, C), C revoked by A concurrently with a
// membership-mutating operation from B, verified with REAL ts-mls decryption
// (not just applicative membership) that C cannot read anything encrypted
// after its removal.
//
// Substitution note (documented, not invented): the codebase exposes no raw
// "self Update" operation for a device to call on itself. The concrete,
// real, already-existing membership-mutating operation available to a
// second device is MlsMembershipService.provisionDevice() (adding one of
// B's own new devices) — used here as B's concurrent operation. This is a
// faithful stand-in for "B mutates the group's membership while A removes
// C": the point under test is the concurrency/security property (does C
// lose access, does the group converge), not the specific proposal type B
// uses to contest the epoch.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet', platform: 'web' };
const CONV_ID = 'conv-remove-update';

// FINDING (documented below, not fixed — see the dedicated test further
// down): removeRevokedDeviceFromAllGroups(), when it loses the epoch race to
// an UNRELATED commit (B's Update, which never touches C), does not itself
// retry the Remove — mls-membership.service.ts's lost-race branch only
// resyncs onto the winning commit and returns. The actual eventual removal
// depends entirely on a SEPARATE mechanism: device-provisioning.service.ts's
// removeRevokedDeviceLeaves(), invoked from checkAndProvisionOnConnect() on
// reconnect (rate-limited to once per 5 minutes,
// REVOKED_SWEEP_MIN_INTERVAL_MS) — itself explicitly documented there as
// "Forensic audit finding F11" fixing the case of a revocation nobody was
// online to see. removeRevokedDeviceFromAllGroups() is documented idempotent
// ("a no-op once the leaf is already gone"), so retrying it here is a
// faithful simulation of that reconnect-sweep retry, not a test-only workaround.
async function converge(a: Device, b: Device, opts: { retryRemove: boolean }): Promise<void> {
  // Mirrors the delivery step already validated in mls-invariants-concurrency.spec.ts:
  // whichever side didn't post the winning commit itself (either because it
  // lost an actual race, or because the commit lock kept it from ever
  // building one) catches up via the same mechanism a real reconnect/sweep
  // uses. C is deliberately never called here — a revoked device's session
  // is invalidated, so it never gets to run this in reality.
  await Promise.all([
    a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A),
    b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B),
  ]);

  if (opts.retryRemove) {
    // Simulates the removeRevokedDeviceLeaves() reconnect-sweep retry --
    // idempotent no-op if C is already gone, actually removes C if the
    // earlier attempt lost its race.
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
  }
}

// The real, decisive proof: encrypt with a survivor's current (post-race)
// state and assert C's own retained (frozen, pre-revocation) state cannot
// decrypt it — a genuine ts-mls cryptographic failure, not an applicative
// membership-list check.
async function assertCCannotDecryptFutureTraffic(a: Device, c: Device, tag: string): Promise<void> {
  const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, `post-revocation secret ${tag}`);
  await expectAsync(
    c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, ciphertext),
  ).toBeRejected();
}

async function setupTriad(): Promise<{ backend: FakeMlsBackend; a: Device; b: Device; c: Device }> {
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  const c = new Device(backend, USER_C, DEVICE_C);
  await makeGroup(CONV_ID, backend, a, [b, c]);
  return { backend, a, b, c };
}

describe('MLS multi-device invariants — Remove(C) concurrent with Update(B) (Section 3, priority)', () => {

  it('Ordering A: Remove(C) completes fully, then Update(B)', async () => {
    const { a, b, c } = await setupTriad();

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('new-device-b-orderingA', CONV_ID, USER_B, DEVICE_B);
    await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

    expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    expect(b.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());
    await assertCCannotDecryptFutureTraffic(a, c, 'orderingA');
  });

  it('Ordering B: Update(B) completes fully, then Remove(C)', async () => {
    const { a, b, c } = await setupTriad();

    await b.membershipSvc.provisionDevice('new-device-b-orderingB', CONV_ID, USER_B, DEVICE_B);
    await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

    expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    expect(b.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());
    await assertCCannotDecryptFutureTraffic(a, c, 'orderingB');
  });

  it('Ordering C: Remove(C) and Update(B) launched truly concurrently with random network delay', async () => {
    const { backend, a, b, c } = await setupTriad();
    backend.delayRangeMs = [0, 10];

    const [resRemove, resUpdate] = await Promise.allSettled([
      a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A),
      b.membershipSvc.provisionDevice('new-device-b-orderingC', CONV_ID, USER_B, DEVICE_B),
    ]);
    expect(resRemove.status).toBe('fulfilled');
    expect(resUpdate.status).toBe('fulfilled');

    await converge(a, b, { retryRemove: true });

    // Whichever of the two commits won epoch 1, the OTHER operation must
    // still have taken effect afterwards (both are real, legitimate
    // conversation-wide changes -- neither should be silently dropped just
    // because it lost the epoch race, only reordered to epoch 2).
    expect(a.memberDeviceIds(CONV_ID)).withContext('C must be gone regardless of race order').not.toContain(DEVICE_C.id);
    expect(b.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());

    await assertCCannotDecryptFutureTraffic(a, c, 'orderingC');
  });

  it('Ordering D: repeated concurrent runs with randomized order/delay (>=100 repetitions)', async () => {
    const REPS = Number((globalThis as { __MLS_REMOVE_UPDATE_REPS__?: number }).__MLS_REMOVE_UPDATE_REPS__ ?? 100);

    for (let i = 0; i < REPS; i++) {
      const { backend, a, b, c } = await setupTriad();
      backend.delayRangeMs = [0, 6];

      // Randomize which operation is kicked off first within the same tick —
      // both are still un-awaited relative to each other, so real
      // concurrency is preserved either way; this only varies which one's
      // synchronous prefix (pre-checks, key package generation) runs first.
      const ops = Math.random() < 0.5
        ? [
            () => a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A),
            () => b.membershipSvc.provisionDevice(`new-device-b-d${i}`, CONV_ID, USER_B, DEVICE_B),
          ]
        : [
            () => b.membershipSvc.provisionDevice(`new-device-b-d${i}`, CONV_ID, USER_B, DEVICE_B),
            () => a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A),
          ];

      const results = await Promise.allSettled(ops.map(op => op()));
      expect(results.every(r => r.status === 'fulfilled'))
        .withContext(`iteration ${i}: ${JSON.stringify(results.map(r => r.status === 'rejected' ? String(r.reason) : 'ok'))}`)
        .toBe(true);

      // retryRemove: true -- see the FINDING documented on converge() above.
      // A single removeRevokedDeviceFromAllGroups() call is NOT guaranteed to
      // remove C when it loses its epoch race to an unrelated commit; only
      // the reconnect-sweep retry (simulated here) makes eventual removal an
      // actually-guaranteed property. The dedicated test below proves the
      // gap this covers for.
      await converge(a, b, { retryRemove: true });

      expect(a.memberDeviceIds(CONV_ID)).withContext(`iteration ${i}`).not.toContain(DEVICE_C.id);
      expect(b.memberDeviceIds(CONV_ID)).withContext(`iteration ${i}`).not.toContain(DEVICE_C.id);
      expect(a.memberDeviceIds(CONV_ID).sort()).withContext(`iteration ${i}`).toEqual(b.memberDeviceIds(CONV_ID).sort());

      await assertCCannotDecryptFutureTraffic(a, c, `orderingD-${i}`);
    }
  }, 300000); // real-crypto 3-member iterations exceed Jasmine's 5s default timeout

  // FINDING (P1 — see the final report for full writeup). Discovered by this
  // suite, not hypothesized: the very first run of "Ordering D" above (before
  // converge() was changed to retry) failed with C still listed as a member.
  // Root cause: mls-membership.service.ts's removeRevokedDeviceFromAllGroups()
  // lost-race branch resyncs onto the OTHER commit and returns -- it does not
  // retry the Remove itself. This test reproduces that exact window
  // deliberately (retryRemove: false) and proves it is not merely an
  // applicative membership gap: C can actually decrypt real traffic sent
  // during it, until the reconnect-sweep retry (removeRevokedDeviceLeaves(),
  // device-provisioning.service.ts) eventually runs.
  //
  // C's own local state is deliberately brought current (catchUpMissedCommits)
  // before the decrypt attempt below -- otherwise a decrypt failure would be
  // ambiguous between "C was cryptographically excluded" (the property this
  // test exists to isolate) and "C simply never received the commit"
  // (an unrelated delivery/session-invalidation question, not a membership
  // question; a real revoked device's session is normally torn down as well,
  // but that is a separate, already-covered protection, not this one).
  it('FINDING: when Remove(C) loses its epoch race to an unrelated commit, C remains a fully capable member (real decrypt succeeds) until the retry runs', async () => {
    const { backend, a, b, c } = await setupTriad();

    // Force the exact losing ordering: B's commit is posted and wins first,
    // so A's Remove — built from the same starting epoch — loses when it
    // posts afterward and resyncs onto B's (unrelated) commit instead.
    await b.membershipSvc.provisionDevice('new-device-b-finding', CONV_ID, USER_B, DEVICE_B);
    const removeResult = await (async () => {
      try {
        await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
        return 'fulfilled';
      } catch (err) {
        return `rejected: ${String(err)}`;
      }
    })();
    expect(removeResult).toBe('fulfilled'); // resyncs silently, does not throw

    await converge(a, b, { retryRemove: false }); // deliberately no retry -- the window under test
    await c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C); // isolate membership from delivery

    // The gap, stated as an invariant violation: C is still a member...
    expect(a.memberDeviceIds(CONV_ID)).withContext('C was not actually removed -- Remove lost its race and was never retried').toContain(DEVICE_C.id);

    // ...and — the decisive part — C can ACTUALLY DECRYPT real traffic sent
    // by a legitimate member during this window. This is not a benign
    // membership-list staleness: C has full read access to the conversation
    // for as long as this window lasts.
    const ciphertext = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'sent while C is still (wrongly) a member');
    const decryptedByC = await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, ciphertext);
    expect(decryptedByC).withContext('C should not be able to read this, but currently can').toBe('sent while C is still (wrongly) a member');

    // Confirms the window is real but bounded: the documented retry path
    // (removeRevokedDeviceLeaves() on reconnect) closes it.
    await converge(a, b, { retryRemove: true });
    expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
    await assertCCannotDecryptFutureTraffic(a, c, 'finding-after-retry');
  });

  it('C cannot decrypt even a message sent in the SAME epoch transition that removed it (not just later traffic)', async () => {
    const { a, b, c } = await setupTriad();

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

    // The very first message encrypted right after the Remove commit lands —
    // C's frozen pre-removal ClientState has no path to this epoch's secrets
    // at all (MLS's core guarantee: a removed member's own key material
    // contributes nothing to the new epoch's key schedule).
    const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'immediately after removal');
    await expectAsync(c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, ciphertext)).toBeRejected();

    // Cross-check the positive case on the same fixture: B (a legitimate
    // survivor) decrypts it fine — proves the failure above is specific to
    // C's removal, not a fixture/harness bug that breaks decryption for everyone.
    const plaintext = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
    expect(plaintext).toBe('immediately after removal');
  });
});
