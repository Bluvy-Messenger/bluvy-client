import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// P0 FIX — removeRevokedDeviceFromAllGroups() client/server reconciliation
// after network failure. This file used to document the P0 finding
// (AUDIT GLOBAL: MLS optimistic writes / crash / server divergence):
// removeRevokedDeviceFromAllGroups()'s non-409 catch (mls-membership.service.ts)
// did `console.error(...); continue;` with no rollback after the optimistic
// Remove write -- empirically proven (real ts-mls decrypt) that a device
// believed-revoked locally could still decrypt traffic from an unaware
// survivor, since the server (and everyone else) never actually applied
// the Remove. Retry was a permanent silent no-op (the local tree already
// has no member matching the revoked device, so the idempotent "nothing to
// remove" pre-check short-circuited every future attempt, including the
// existing removeRevokedDeviceLeaves() reconnect sweep).
//
// Fixed identically to provisionDevice()/reprovisionLostStateDevice(): the
// SAME reconcileAfterPostCommitFailure() helper (mls-membership.service.ts)
// is now also called from removeRevokedDeviceFromAllGroups()'s non-409
// catch branch, per-conversation (the existing for-loop + `continue` shape
// is preserved -- each conversation still reconciles and moves on to the
// next independently).
//
// Crash/restart (a persisted pending-operation marker like
// PendingReprovision) is explicitly OUT OF SCOPE for this fix, per the
// task's instruction not to introduce a new persistence mechanism unless
// strictly demonstrated necessary -- see Section 8/the final report.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet (revoked)', platform: 'web' };
const USER_D: UserProfile = { did: 'did:plc:dave', handle: 'dave.test', displayName: 'Dave', avatarUrl: null };
const DEVICE_D: DeviceInfo = { id: 'device-d1', name: 'Watch (revoked)', platform: 'ios' };
const CONV_ID = 'conv-removerevoked-divergence';

function interceptPostCommit_CaseA(backend: FakeMlsBackend): void {
  backend.postCommit = (async () => {
    throw new Error('simulated: network failure, request never reached the server');
  }) as typeof backend.postCommit;
}

function interceptPostCommit_CaseB(backend: FakeMlsBackend): void {
  const original = backend.postCommit.bind(backend);
  backend.postCommit = (async (...args: Parameters<typeof backend.postCommit>) => {
    await original(...args); // really accepted and stored server-side
    throw new Error('simulated: server accepted the commit but the response was lost');
  }) as typeof backend.postCommit;
}

function restoreHealthyPostCommit(backend: FakeMlsBackend): void {
  const proto = Object.getPrototypeOf(backend);
  (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
}

describe('P0 FIX — removeRevokedDeviceFromAllGroups() client/server reconciliation after network failure', () => {

  // ── Section 2: Case A ────────────────────────────────────────────────
  describe('Section 2: Case A (server never received the Remove)', () => {
    it('rollback restores client to the last confirmed epoch -- the "revoked" device was never actually revoked, and can still decrypt', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      const epochBefore = a.epoch(CONV_ID);
      const commitsBefore = backend.getCommits(CONV_ID).length;
      interceptPostCommit_CaseA(backend);

      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      expect(a.epoch(CONV_ID)).withContext('rolled back to the last confirmed epoch').toBe(epochBefore);
      expect(a.memberDeviceIds(CONV_ID)).withContext('C is still a member -- never actually revoked').toContain(DEVICE_C.id);
      expect(backend.getCommits(CONV_ID).length).withContext('server received NOTHING').toBe(commitsBefore);

      // CRYPTOGRAPHIC PROOF: C (never actually revoked) can decrypt.
      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'after rollback -- C is still a real member');
      const plaintext = await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA);
      expect(plaintext).withContext('C decrypt SUCCESS -- correctly still a member, no phantom revocation').toBe('after rollback -- C is still a real member');
    });

    it('a subsequent retry (network now healthy) genuinely performs the Remove -- server posted, C actually loses access', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      interceptPostCommit_CaseA(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      restoreHealthyPostCommit(backend);
      const postCommitSpy = spyOn(backend, 'postCommit').and.callThrough();
      const commitsBeforeRetry = backend.getCommits(CONV_ID).length;

      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      expect(postCommitSpy).withContext('retry reaches the network this time -- rollback made C findable again').toHaveBeenCalled();
      expect(backend.getCommits(CONV_ID).length).withContext('a real Remove commit was posted').toBe(commitsBeforeRetry + 1);
      expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);

      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'C is genuinely revoked now');
      await expectAsync(
        c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA),
      ).withContext('C genuinely cannot decrypt after the real Remove').toBeRejected();
    });
  });

  // ── Section 3: Case B ────────────────────────────────────────────────
  describe('Section 3: Case B (server accepted the Remove, response lost)', () => {
    it('A converges automatically onto its own server-confirmed Remove -- C is genuinely revoked, no double Commit', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      const commitsBefore = backend.getCommits(CONV_ID).length;
      interceptPostCommit_CaseB(backend);

      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).withContext('exactly ONE commit stored -- no duplicate from reconciliation').toBe(commitsBefore + 1);
      expect(a.epoch(CONV_ID)).toBe(2);
      expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);

      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());

      // CRYPTOGRAPHIC PROOF, all three assertions required by the task.
      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-revocation traffic');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).withContext('A -> encrypt SUCCESS, B decrypt SUCCESS').toBe('post-revocation traffic');
      await expectAsync(
        c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA),
      ).withContext('revoked C decrypt FAILURE -- genuinely revoked this time').toBeRejected();
    });
  });

  // ── Section 4: per-conversation loop shape preserved ────────────────
  describe('Section 4: the for-loop + continue shape is preserved -- reconciliation is per-conversation, not global', () => {
    it('a failure reconciling conversation 1 does not block conversation 2 from being processed and succeeding', async () => {
      const CONV_2 = 'conv-removerevoked-divergence-2';
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);
      await makeGroup(CONV_2, backend, a, [b, c]);

      // Only conv-removerevoked-divergence-2's postCommit fails (Case A);
      // CONV_ID's own must succeed normally, proving the loop moves on.
      const original = backend.postCommit.bind(backend);
      backend.postCommit = (async (...args: Parameters<typeof backend.postCommit>) => {
        if (args[0] === CONV_2) throw new Error('simulated: network failure for conv 2 only');
        return original(...args);
      }) as typeof backend.postCommit;

      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      expect(a.memberDeviceIds(CONV_ID)).withContext('conv 1: real Remove succeeded').not.toContain(DEVICE_C.id);
      expect(a.memberDeviceIds(CONV_2)).withContext('conv 2: rolled back, C still there (network failed)').toContain(DEVICE_C.id);
    });
  });

  // ── Section 5: concurrency (CAS guard) ──────────────────────────────
  describe('Section 5: concurrency (CAS guard) -- rollback never clobbers a more recent state', () => {
    it('Remove(D) + a genuine concurrent Commit from another device: CAS correctly resolves without a fork', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A),
        b.membershipSvc.provisionDevice('device-b-new', CONV_ID, USER_B, DEVICE_B),
      ]);
      console.log('[P0 FIX Section 5] Commit-concurrent A result:', resA.status, '| B result:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).withContext('A and B converge -- no fork').toEqual(b.memberDeviceIds(CONV_ID).sort());
    });

    it('Remove(D) + Remove(E) concurrent: both eventually resolve correctly, no wrong member removed', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      const e = new Device(backend, { did: 'did:plc:eve', handle: 'eve.test', displayName: 'Eve', avatarUrl: null }, { id: 'device-e1', name: 'Watch', platform: 'ios' });
      await makeGroup(CONV_ID, backend, a, [b, d, e]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A),
        b.membershipSvc.removeRevokedDeviceFromAllGroups('device-e1', USER_B, DEVICE_B),
      ]);
      console.log('[P0 FIX Section 5] Remove+Remove concurrent A result:', resA.status, '| B result:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      // Retry only whichever target is ACTUALLY still present -- not both
      // unconditionally. Reason, unrelated to this fix: acquireCommitLock()
      // has no client-callable release path when a caller decides "nothing
      // to do" before ever posting a commit (confirmed against the real
      // backend -- releaseCommitLock(), mls.service.ts:977, is only ever
      // invoked internally by storeMlsCommit()'s own success path; there is
      // no release-commit-lock REST endpoint at all, confirmed by reading
      // conversations.routes.ts). Retrying an ALREADY-removed target would
      // needlessly re-acquire and hold the lock until the real backend's
      // 5-minute staleness reclaim (MLS_LOCK_STALE_MS, mls.service.ts:943),
      // blocking the side that still has real work to do. This is a
      // pre-existing property of ALL THREE membership-mutating methods
      // (identical in provisionDevice()/reprovisionLostStateDevice()), not
      // something introduced or fixed by this task's change, and out of
      // this task's strict scope -- so the test checks first, exactly like
      // a real caller would only retry a target it knows is still pending.
      const stillPresent = a.memberDeviceIds(CONV_ID);
      if (stillPresent.includes(DEVICE_D.id)) await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A);
      if (stillPresent.includes('device-e1')) await b.membershipSvc.removeRevokedDeviceFromAllGroups('device-e1', USER_B, DEVICE_B);
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());
      expect(a.memberDeviceIds(CONV_ID)).withContext('D correctly removed').not.toContain(DEVICE_D.id);
      expect(a.memberDeviceIds(CONV_ID)).withContext('E correctly removed').not.toContain('device-e1');
      expect(a.memberDeviceIds(CONV_ID)).withContext('A and B are NOT removed').toEqual(jasmine.arrayContaining([DEVICE_A.id, DEVICE_B.id]));
    });

    it('Remove(D) + reprovision(D) concurrent (contradictory intents from two devices): resolves without a fork or a resurrected-then-removed inconsistency', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A),
        b.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_B, DEVICE_B),
      ]);
      console.log('[P0 FIX Section 5] Remove+reprovision concurrent A result:', resA.status, '| B result:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).withContext('A and B converge on the SAME outcome, whichever won -- no fork').toEqual(b.memberDeviceIds(CONV_ID).sort());
    });

    it('Remove(D) + a concurrent Update (provisionDevice() stand-in, same substitution convention as mls-invariants-remove-update.spec.ts)', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A),
        b.membershipSvc.provisionDevice('device-b-update-stand-in', CONV_ID, USER_B, DEVICE_B),
      ]);
      console.log('[P0 FIX Section 5] Remove+Update-stand-in concurrent A result:', resA.status, '| B result:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());
      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-concurrency');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('post-concurrency');
    });
  });

  // ── Section 6: multiple devices, multiple revocations ────────────────
  describe('Section 6: A + B + C + D, sequential Remove(B)/Remove(C)/Remove(D) under mixed network failures', () => {
    it('Remove(B) fails (Case A, rolls back), Remove(C) succeeds normally, Remove(D) fails then retries successfully -- final state exactly {A}', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, c, d]);

      // Remove(B): network fails -- must roll back, B untouched.
      interceptPostCommit_CaseA(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);
      expect(a.memberDeviceIds(CONV_ID)).withContext('B rolled back -- still present').toContain(DEVICE_B.id);

      // Remove(C): network healthy -- succeeds for real.
      restoreHealthyPostCommit(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
      expect(a.memberDeviceIds(CONV_ID)).withContext('C genuinely removed').not.toContain(DEVICE_C.id);
      expect(a.memberDeviceIds(CONV_ID)).withContext('B still present -- unaffected by C\'s successful removal').toContain(DEVICE_B.id);

      // Remove(D): network fails first...
      interceptPostCommit_CaseA(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A);
      expect(a.memberDeviceIds(CONV_ID)).withContext('D rolled back after failure').toContain(DEVICE_D.id);

      // ...then a real retry succeeds.
      restoreHealthyPostCommit(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_A, DEVICE_A);

      // Now finish the deferred B removal.
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);

      const finalMembers = a.memberDeviceIds(CONV_ID);
      expect(finalMembers).withContext('final state: exactly {A} -- no wrongly-removed member, no forgotten revocation').toEqual([DEVICE_A.id]);

      // No regression of the double-Remove fix: findLeafIndex()-based
      // lookup must still correctly resolve B/C/D's true leaves across
      // this whole sequence of mixed successes/rollbacks/retries, none of
      // which produced a "Tried to remove empty leaf node" throw or a
      // wrong-member removal (already asserted above via exact final
      // membership).
      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBeGreaterThan(0);
      expect(b.memberDeviceIds(CONV_ID)).toEqual(finalMembers);
    });
  });

  // ── Section 7: retry sequences ────────────────────────────────────────
  describe('Section 7: retry sequences', () => {
    it('failure -> recovery (inline) -> retry -> success: converges cleanly', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      interceptPostCommit_CaseA(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      restoreHealthyPostCommit(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());
    });

    it('failure -> failure -> failure -> success: no epoch drift, no duplicate commit, no member lost', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);
      const epochBefore = a.epoch(CONV_ID);

      interceptPostCommit_CaseA(backend);
      for (let i = 0; i < 3; i++) {
        await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
        expect(a.epoch(CONV_ID)).withContext(`no drift after failure #${i + 1}`).toBe(epochBefore);
      }

      restoreHealthyPostCommit(backend);
      await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).toBe(2); // genesis + exactly one real Remove
      expect(a.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
      expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
    });
  });

  // ── Section 9: repetition ────────────────────────────────────────────
  describe('Section 9: repetition (rollback is deterministic, not a flaky race)', () => {
    it('Case A rolls back identically across 100 repetitions -- 0/100 persistent divergence', async () => {
      let divergenceCount = 0;
      for (let i = 0; i < 100; i++) {
        const backend = new FakeMlsBackend();
        const a = new Device(backend, USER_A, DEVICE_A);
        const b = new Device(backend, USER_B, DEVICE_B);
        const c = new Device(backend, USER_C, { ...DEVICE_C, id: `device-c-${i}` });
        await makeGroup(CONV_ID, backend, a, [b, c]);

        const epochBefore = a.epoch(CONV_ID);
        const commitsBefore = backend.getCommits(CONV_ID).length;
        interceptPostCommit_CaseA(backend);

        await a.membershipSvc.removeRevokedDeviceFromAllGroups(`device-c-${i}`, USER_A, DEVICE_A);

        const diverged = a.epoch(CONV_ID) !== epochBefore || backend.getCommits(CONV_ID).length !== commitsBefore;
        if (diverged) divergenceCount++;
      }
      console.log(`[P0 FIX Section 9] persistent divergence in ${divergenceCount}/100 repetitions (expected: 0).`);
      expect(divergenceCount).withContext('rollback is 100% deterministic').toBe(0);
    }, 120000);

    it('Case B reconciles identically across 20 repetitions -- exactly one commit each time, revoked device always genuinely revoked', async () => {
      for (let i = 0; i < 20; i++) {
        const backend = new FakeMlsBackend();
        const a = new Device(backend, USER_A, DEVICE_A);
        const b = new Device(backend, USER_B, DEVICE_B);
        const c = new Device(backend, USER_C, { ...DEVICE_C, id: `device-c-caseb-${i}` });
        await makeGroup(CONV_ID, backend, a, [b, c]);
        const commitsBefore = backend.getCommits(CONV_ID).length;
        interceptPostCommit_CaseB(backend);

        await a.membershipSvc.removeRevokedDeviceFromAllGroups(`device-c-caseb-${i}`, USER_A, DEVICE_A);

        expect(backend.getCommits(CONV_ID).length).withContext(`rep ${i}: exactly one commit`).toBe(commitsBefore + 1);
        expect(a.memberDeviceIds(CONV_ID)).not.toContain(`device-c-caseb-${i}`);
      }
    }, 60000);
  });
});
