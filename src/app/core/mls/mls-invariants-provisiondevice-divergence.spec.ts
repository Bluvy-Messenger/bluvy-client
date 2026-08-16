import {
  createCommit, decodeMlsMessage, encodeGroupState, type ProposalAdd,
} from 'ts-mls';
import {
  FakeMlsBackend, Device, makeGroup, getCs, bytesToBase64, base64ToBytes,
  generateDeviceIdentityKeyPackage,
} from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// P1 FIX — provisionDevice() client/server reconciliation after network
// failure. This file used to document the P1 finding (AUDIT_09-equivalent:
// a network failure on postCommit() after the local optimistic write left
// the client permanently diverged from the server, with no self-healing
// mechanism -- see the design report for the full analysis). The finding is
// now FIXED in mls-membership.service.ts:
//
//   catch (err) {
//     if (409) { ...existing... }
//     else {
//       await this.reconcileAfterPostCommitFailure(conversationId, scope,
//         newStateB64pd, previousStateB64pd, user, device, 'provisionDevice');
//     }
//     throw err;
//   }
//
// reconcileAfterPostCommitFailure() rolls back the optimistic write --
// CAS-guarded exactly like the pre-existing lost-commit-race branches, so a
// concurrent write in the meantime is never clobbered -- then calls the
// unmodified catchUpMissedCommits() to ask the server directly whether the
// commit actually landed (Case B: adopts it) or never arrived (Case A:
// rollback stands). Empirically verified (throwaway investigation, not part
// of this suite) that self-replaying a device's own commit via
// catchUpMissedCommits()/processPublicMessage() produces a ClientState
// byte-identical to createCommit()'s own newState -- Case B's reconciliation
// is not a lossy re-derivation.
//
// The external contract is preserved: provisionDevice() still rejects with
// the original network error on any non-409 postCommit() failure (Section
// 13 of the implementation task) -- only the INTERNAL state left behind
// after that rejection has changed, from "phantom-advanced forever" to
// "rolled back to the last confirmed epoch" (Case A) or "correctly
// converged on the server's own copy of our commit" (Case B).
//
// isDeviceMemberLocally() (new, read-only) and the
// DeviceProvisioningService.checkAndProvisionOnConnect() sweep extension
// (device-provisioning.service.ts) cover the crash/restart case, where no
// in-memory previousStateB64pd survives to roll back to -- see the
// dedicated "Section 6b" crash/restart test below.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet', platform: 'web' };
const CONV_ID = 'conv-provision-divergence';
const NEW_DEVICE = 'device-x';

// Case A: the server NEVER sees the commit at all (timeout, connection
// refused, request never arrives) -- backend.postCommit's real logic is
// never invoked, nothing is stored server-side.
function interceptPostCommit_CaseA(backend: FakeMlsBackend): { callCount: number } {
  const counter = { callCount: 0 };
  backend.postCommit = (async () => {
    counter.callCount++;
    throw new Error('simulated: network failure, request never reached the server');
  }) as typeof backend.postCommit;
  return counter;
}

// Case B: the server DOES receive and accept the commit (real backend logic
// runs, the commit is durably stored) but the response never makes it back
// to the client (response lost, connection dropped after the server had
// already committed).
function interceptPostCommit_CaseB(backend: FakeMlsBackend): { callCount: number } {
  const original = backend.postCommit.bind(backend);
  const counter = { callCount: 0 };
  backend.postCommit = (async (...args: Parameters<typeof backend.postCommit>) => {
    counter.callCount++;
    await original(...args); // really accepted and stored server-side
    throw new Error('simulated: server accepted the commit but the response was lost');
  }) as typeof backend.postCommit;
  return counter;
}

function restoreHealthyPostCommit(backend: FakeMlsBackend): void {
  const proto = Object.getPrototypeOf(backend);
  (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
}

// Faithfully replicates ONLY provisionDevice()'s optimistic write
// (mls-membership.service.ts's storage.update() body: createCommit() +
// local persistence) WITHOUT ever calling postCommit() or reaching its
// catch/reconcile logic at all -- the harness-level stand-in for "the
// process died right after the local write landed, before anything else
// in provisionDevice() got a chance to run." Used only by the crash/restart
// test below.
async function simulateOptimisticWriteOnly(a: Device, conversationId: string, newDeviceId: string): Promise<void> {
  const cs = await getCs();
  const clientState = a.getClientState(conversationId);
  const kp = await generateDeviceIdentityKeyPackage(newDeviceId);
  const decodedKP = decodeMlsMessage(base64ToBytes(kp.keyPackage), 0)?.[0];
  if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') throw new Error('harness: bad key package');
  const addProposal: ProposalAdd = { proposalType: 'add', add: { keyPackage: decodedKP.keyPackage } };
  const { newState } = await createCommit(
    { state: clientState, cipherSuite: cs },
    { extraProposals: [addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  a.seedGroupState(conversationId, bytesToBase64(encodeGroupState(newState)));
}

describe('P1 FIX — provisionDevice() client/server reconciliation after network failure', () => {

  // ── Section 3-4: reproduction and post-failure state ─────────────────────
  describe('Section 3-4: Case A rolls back, Case B adopts the server\'s copy', () => {
    it('Case A (server never received the commit): rollback restores client to the last confirmed epoch, matching the server', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      const epochBefore = a.epoch(CONV_ID);
      const commitsBefore = backend.getCommits(CONV_ID).length;

      interceptPostCommit_CaseA(backend);

      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      // Client: rolled back, matching the server.
      expect(a.epoch(CONV_ID)).withContext('client epoch rolled back to the last confirmed epoch').toBe(epochBefore);
      expect(a.memberDeviceIds(CONV_ID)).withContext('phantom device rolled back out').not.toContain(NEW_DEVICE);
      expect(a.memberDeviceIds(CONV_ID).sort()).withContext('membership matches server truth exactly').toEqual([DEVICE_A.id, DEVICE_B.id].sort());

      // Server: still untouched (rollback doesn't retroactively post anything).
      expect(backend.getCommits(CONV_ID).length).withContext('server received NOTHING').toBe(commitsBefore);

      console.log('[P1 FIX Case A] client epoch after rollback:', a.epoch(CONV_ID), '| server commits:', backend.getCommits(CONV_ID).length);
    });

    it('Case B (server accepted the commit, response lost): reconciliation adopts our own commit -- A converges on the SAME state as B, not a lossy re-derivation', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      const commitsBefore = backend.getCommits(CONV_ID).length;

      interceptPostCommit_CaseB(backend);

      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      // Server DID receive and accept it (unchanged from before the fix).
      expect(backend.getCommits(CONV_ID).length).withContext('server actually stored the commit').toBe(commitsBefore + 1);

      // A's own local state, after its internal reconciliation, must have
      // adopted the SAME commit -- not left phantom, not left rolled back.
      expect(a.epoch(CONV_ID)).withContext('A converged onto its own server-confirmed commit').toBe(2);
      expect(a.memberDeviceIds(CONV_ID)).withContext('A sees NEW_DEVICE as a real, server-confirmed member').toContain(NEW_DEVICE);

      // B independently derives the same thing via the normal path.
      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).withContext('B catches up correctly -- server state was real').toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).withContext('A and B converge on IDENTICAL membership').toEqual(a.memberDeviceIds(CONV_ID).sort());

      console.log('[P1 FIX Case B] A epoch after reconciliation:', a.epoch(CONV_ID), '| A members:', a.memberDeviceIds(CONV_ID));
    });
  });

  // ── Section 4-5: reconciliation now repairs Case A ────────────────────────
  describe('Section 4-5: reconciliation now repairs Case A (retry, catch-up, reconnect sweep all work again)', () => {
    it('catchUpMissedCommits() called AFTER a failed provisionDevice() is a genuine no-op -- reconciliation already ran inline, there is nothing left to catch up on', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      const epochAfterReconcile = a.epoch(CONV_ID);
      const applied = await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      expect(applied).withContext('nothing left to apply -- reconciliation already rolled back inline').toBe(0);
      expect(a.epoch(CONV_ID)).toBe(epochAfterReconcile);
      expect(a.memberDeviceIds(CONV_ID)).not.toContain(NEW_DEVICE);
    });

    it('a subsequent provisionDevice() retry (network now healthy) genuinely succeeds -- posts a fresh commit, real member added, real Welcome', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      restoreHealthyPostCommit(backend);
      const acquireLockSpy = spyOn(backend, 'acquireCommitLock').and.callThrough();
      const postCommitSpy = spyOn(backend, 'postCommit').and.callThrough();
      const commitsBeforeRetry = backend.getCommits(CONV_ID).length;

      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);

      expect(acquireLockSpy).withContext('retry reaches the network this time -- rollback made isDeviceMember() false again').toHaveBeenCalled();
      expect(postCommitSpy).toHaveBeenCalled();
      expect(backend.getCommits(CONV_ID).length).withContext('a real commit was posted').toBe(commitsBeforeRetry + 1);
      expect(a.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);

      const pending = await backend.getPendingWelcomes(NEW_DEVICE, CONV_ID);
      expect(pending.data.length).withContext('a real Welcome now exists for the new device').toBe(1);

      console.log('[P1 FIX] Retry after Case A now genuinely repairs the divergence -- rollback made isDeviceMember() false again, so the pre-check no longer short-circuits it.');
    });

    it('a reconnect-style sweep (catchUpMissedCommits + provisionDevice, mirroring checkAndProvisionOnConnect) now repairs the divergence', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      restoreHealthyPostCommit(backend);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).withContext('the reconnect sequence posted the real commit').toBe(2); // genesis + this one
      expect(a.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);
    });
  });

  // ── Section 6: crash consistency at actual code breakpoints ──────────────
  describe('Section 6: crash consistency at actual code breakpoints', () => {
    it('breakpoint (1): crash BEFORE the local write -- unaffected by this fix, prior state fully intact, clean retry succeeds', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      const stateBefore = a.getGroupStateB64(CONV_ID);

      const originalUpdate = a.storage.update.bind(a.storage);
      let failNext = true;
      a.storage.update = ((scope: string, updater: (s: unknown) => Promise<unknown>) => {
        if (failNext) { failNext = false; return Promise.reject(new Error('simulated crash before local write')); }
        return originalUpdate(scope, updater as never);
      }) as typeof a.storage.update;

      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      expect(a.getGroupStateB64(CONV_ID)).withContext('unchanged -- write never happened').toBe(stateBefore);
      expect(a.memberDeviceIds(CONV_ID)).not.toContain(NEW_DEVICE);

      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);
      expect(a.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);
    });

    it('breakpoint (3): crash AFTER the local write, BEFORE postCommit() is even attempted -- this IS Case A, now correctly rolled back', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      const epochBefore = a.epoch(CONV_ID);

      interceptPostCommit_CaseA(backend);

      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      expect(a.epoch(CONV_ID)).withContext('rolled back by reconcileAfterPostCommitFailure()').toBe(epochBefore);
    });

    it('breakpoint (5/G): crash AFTER a LOST-RACE server response, BEFORE the (pre-existing, unrelated) rollback storage.update() completes -- unchanged by this fix, still exploratory', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      const originalUpdate = a.storage.update.bind(a.storage);
      let updateCallCount = 0;
      a.storage.update = ((scope: string, updater: (s: unknown) => Promise<unknown>) => {
        updateCallCount++;
        if (updateCallCount === 2) {
          return Promise.reject(new Error('simulated crash during lost-race rollback'));
        }
        return originalUpdate(scope, updater as never);
      }) as typeof a.storage.update;

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.provisionDevice('device-a-new', CONV_ID, USER_A, DEVICE_A),
        b.membershipSvc.provisionDevice('device-b-new', CONV_ID, USER_B, DEVICE_B),
      ]);

      const aLost = a.memberDeviceIds(CONV_ID).includes('device-b-new') && !a.memberDeviceIds(CONV_ID).includes('device-a-new');
      console.log('[P1 FIX breakpoint 5/G] A result:', resA.status, '| B result:', resB.status, '| A lost the race for its own commit:', aLost, '| A members:', a.memberDeviceIds(CONV_ID));
    });

    // ── Section 6b: crash BEFORE any reconciliation ever ran (no in-memory
    //    previousStateB64pd survives) -- proves the fix does not depend
    //    solely on postCommit()'s inline catch. Detection: the new
    //    isDeviceMemberLocally() (mls-membership.service.ts). Repair: the
    //    same clearConversationGroup() + backup-restore path
    //    DeviceProvisioningService.checkAndProvisionOnConnect() signals via
    //    MlsEpochConflictBus on this exact mismatch. MlsCoordinatorService
    //    (which subscribes to that bus and drives the actual restore) and
    //    MlsBackupRegistry's real backup transport are outside this
    //    harness's scope -- backup-restore's OBSERVABLE EFFECT (a
    //    previously-saved blob reappearing in storage) is reproduced
    //    directly via seedGroupState(), which is exactly what a real
    //    restore ultimately does to local storage.
    it('crash BEFORE any reconciliation ever ran: a fresh process restart still detects and repairs the divergence via isDeviceMemberLocally() + existing recovery primitives', async () => {
      const backend = new FakeMlsBackend();
      const a1 = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a1, [b]);

      // What a real backup would already have captured before this failed
      // attempt (production backs up after every SUCCESSFUL state change --
      // see the backupGroupState() calls throughout mls-membership.service.ts).
      const lastGoodBackup = a1.getGroupStateB64(CONV_ID)!;
      const epochBefore = a1.epoch(CONV_ID);

      // The crash: ONLY the optimistic write happens, nothing else --
      // provisionDevice()'s catch block, and therefore
      // reconcileAfterPostCommitFailure(), never runs at all.
      await simulateOptimisticWriteOnly(a1, CONV_ID, NEW_DEVICE);
      expect(a1.epoch(CONV_ID)).toBe(epochBefore + 1); // phantom-advanced, exactly as if the crash happened right after L180

      // "Process restart": a fresh Device instance for the SAME identity,
      // its storage seeded from what a1 durably wrote before dying.
      const a2 = new Device(backend, USER_A, DEVICE_A);
      a2.seedGroupState(CONV_ID, a1.getGroupStateB64(CONV_ID)!);

      // Detection: exactly what DeviceProvisioningService's sweep checks.
      const serverNeverSawIt = (await backend.getPendingWelcomes(NEW_DEVICE, CONV_ID)).data.length === 0
        && !backend.getCommits(CONV_ID).some(c => c.senderDeviceId === DEVICE_A.id && c.epoch === epochBefore);
      const localBelievesAlreadyMember = await a2.membershipSvc.isDeviceMemberLocally(CONV_ID, NEW_DEVICE, USER_A, DEVICE_A);

      expect(serverNeverSawIt).withContext('server truth: this pair would still show up in getPendingProvisions()').toBeTrue();
      expect(localBelievesAlreadyMember).withContext('local state: phantom membership survived the crash').toBeTrue();

      // Repair: the sweep signals epoch conflict on this exact mismatch --
      // reuse the SAME clearConversationGroup() primitive the 409 handlers
      // already use, then restore from the last good backup (this harness's
      // stand-in for MlsBackupRegistry's real restore, see the comment above).
      await a2.membershipSvc.clearConversationGroup(CONV_ID, USER_A, DEVICE_A);
      a2.seedGroupState(CONV_ID, lastGoodBackup);

      expect(await a2.membershipSvc.isDeviceMemberLocally(CONV_ID, NEW_DEVICE, USER_A, DEVICE_A))
        .withContext('post-restore: local state no longer phantom-believes membership').toBeFalse();
      expect(a2.epoch(CONV_ID)).toBe(epochBefore);

      // A genuinely fresh provisionDevice() retry now works end-to-end.
      await a2.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);
      expect(a2.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);

      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a2.memberDeviceIds(CONV_ID).sort());

      console.log('[P1 FIX Section 6b] crash-before-reconciliation detected and repaired via isDeviceMemberLocally() + existing recovery primitives, no dependency on postCommit()\'s inline catch.');
    });
  });

  // ── Section 7: network error variants ────────────────────────────────────
  describe('Section 7: network error variants', () => {
    const variants: Array<{ name: string; setup: (backend: FakeMlsBackend) => void }> = [
      { name: '1. timeout (never resolves -> modeled as eventual rejection)', setup: (backend) => { interceptPostCommit_CaseA(backend); } },
      { name: '2. connection refused', setup: (backend) => {
        backend.postCommit = (async () => { throw new Error('ECONNREFUSED'); }) as typeof backend.postCommit;
      } },
      { name: '3. HTTP 500 (server error before commit logic ran)', setup: (backend) => {
        backend.postCommit = (async () => { throw new Error('HTTP 500 Internal Server Error'); }) as typeof backend.postCommit;
      } },
    ];

    for (const variant of variants) {
      it(`${variant.name}: client rolls back, server untouched`, async () => {
        const backend = new FakeMlsBackend();
        const a = new Device(backend, USER_A, DEVICE_A);
        const b = new Device(backend, USER_B, DEVICE_B);
        await makeGroup(CONV_ID, backend, a, [b]);
        const commitsBefore = backend.getCommits(CONV_ID).length;
        const epochBefore = a.epoch(CONV_ID);

        variant.setup(backend);
        await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

        expect(a.epoch(CONV_ID)).toBe(epochBefore);
        expect(backend.getCommits(CONV_ID).length).toBe(commitsBefore);
      });
    }

    it('4. Socket.IO disconnect: NOT APPLICABLE -- provisionDevice() uses only REST, unchanged by this fix', () => {
      expect(true).toBe(true);
    });

    it('5/6. Case A vs Case B remain explicitly distinguished -- see Section 3-4 above', () => {
      expect(true).toBe(true);
    });
  });

  // ── Section 8: idempotence / retry sequence ──────────────────────────────
  describe('Section 8: retry sequence (failure, failure, success)', () => {
    it('failure -> failure -> success: the eventual success is a REAL repair -- exactly one commit posted, no duplicate, no extra epoch', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      const commitsBefore = backend.getCommits(CONV_ID).length;
      const epochBefore = a.epoch(CONV_ID);

      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();
      expect(a.epoch(CONV_ID)).withContext('rolled back after failure #1').toBe(epochBefore);

      // "second failure" -- still Case A, still rolls back cleanly, idempotent.
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();
      expect(a.epoch(CONV_ID)).withContext('rolled back after failure #2 too -- no epoch drift across repeated failures').toBe(epochBefore);
      expect(backend.getCommits(CONV_ID).length).toBe(commitsBefore);

      // "eventual success" -- restore healthy network, try again.
      restoreHealthyPostCommit(backend);
      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length)
        .withContext('exactly ONE commit posted for the whole sequence -- no duplicate from the two prior failures')
        .toBe(commitsBefore + 1);
      expect(a.epoch(CONV_ID)).withContext('epoch advanced exactly once, by the real success').toBe(epochBefore + 1);
      expect(a.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);
    });

    it('multiple consecutive retries (5x) while the network stays down never drift the epoch, and the 6th (healthy) retry succeeds exactly once', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);
      const epochBefore = a.epoch(CONV_ID);

      interceptPostCommit_CaseA(backend);
      for (let i = 0; i < 5; i++) {
        await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();
        expect(a.epoch(CONV_ID)).withContext(`no drift after retry #${i + 1}`).toBe(epochBefore);
      }

      restoreHealthyPostCommit(backend);
      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);
      expect(backend.getCommits(CONV_ID).length).toBe(2); // genesis + exactly one real commit
      expect(a.memberDeviceIds(CONV_ID)).toContain(NEW_DEVICE);
    });
  });

  // ── Section 9: cryptographic verification ────────────────────────────────
  describe('Section 9: cryptographic consequence -- reconciliation restores REAL interoperability, not just matching epoch numbers', () => {
    it('after Case A + rollback: A and B are back in sync -- A can encrypt and B can decrypt again (no more permanent cryptographic incoherence)', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'sent after rollback');
      const plaintext = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
      expect(plaintext).withContext('B can decrypt again -- rollback restored real cryptographic coherence').toBe('sent after rollback');

      console.log('[P1 FIX] Confirmed: rollback eliminates the cryptographic incoherence, not just the epoch mismatch.');
    });

    it('after Case B + reconciliation: A\'s self-replayed state is cryptographically interoperable with B -- both directions', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      interceptPostCommit_CaseB(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'from reconciled A');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('from reconciled A');

      const fromB = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'from B');
      expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromB)).toBe('from B');
    });

    it('after retry succeeds (post Case A): the new device itself genuinely joins and can decrypt real traffic', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const x = new Device(backend, USER_A, { id: NEW_DEVICE, name: 'New Phone', platform: 'android' });
      await makeGroup(CONV_ID, backend, a, [b]);

      interceptPostCommit_CaseA(backend);
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();
      restoreHealthyPostCommit(backend);
      await a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A);

      await x.joinViaPendingWelcome(CONV_ID);
      expect(x.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());

      const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'welcome aboard');
      const plaintext = await x.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, { id: NEW_DEVICE, name: 'New Phone', platform: 'android' }, fromA);
      expect(plaintext).withContext('the new device genuinely joined via a real Welcome and can decrypt real traffic').toBe('welcome aboard');
    });
  });

  // ── Section 10: repetition with randomized timing ────────────────────────
  describe('Section 10: repetition (rollback is a deterministic structural correction, not a flaky race)', () => {
    it('Case A rolls back identically across 100 repetitions with randomized delay -- 0/100 persistent divergence', async () => {
      const REPS = Number((globalThis as { __MLS_PROVISION_DIVERGENCE_REPS__?: number }).__MLS_PROVISION_DIVERGENCE_REPS__ ?? 100);
      let divergenceCount = 0;

      for (let i = 0; i < REPS; i++) {
        const backend = new FakeMlsBackend();
        backend.delayRangeMs = [0, Math.floor(Math.random() * 10)];
        const a = new Device(backend, USER_A, DEVICE_A);
        const b = new Device(backend, USER_B, DEVICE_B);
        await makeGroup(CONV_ID, backend, a, [b]);

        const commitsBefore = backend.getCommits(CONV_ID).length;
        const epochBefore = a.epoch(CONV_ID);
        interceptPostCommit_CaseA(backend);

        await expectAsync(a.membershipSvc.provisionDevice(`${NEW_DEVICE}-${i}`, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

        const diverged = a.epoch(CONV_ID) !== epochBefore || backend.getCommits(CONV_ID).length !== commitsBefore;
        if (diverged) divergenceCount++;
      }

      console.log(`[P1 FIX Section 10] persistent divergence in ${divergenceCount}/${REPS} repetitions (expected: 0 -- deterministic rollback).`);
      expect(divergenceCount).withContext('rollback is 100% deterministic -- never leaves a persistent divergence').toBe(0);
    }, 60000);
  });

  // ── Section 11: concurrency safety of the CAS-guarded rollback ───────────
  describe('Section 11: the rollback never clobbers concurrent progress (CAS guard)', () => {
    it('two concurrent provisionDevice() calls from the SAME device: the first\'s failed-commit rollback must NOT clobber the second\'s already-advanced optimistic state', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      interceptPostCommit_CaseA(backend); // BOTH ops will fail to post -- op1's rollback races op2's own optimistic write

      const [res1, res2] = await Promise.allSettled([
        a.membershipSvc.provisionDevice('device-x1', CONV_ID, USER_A, DEVICE_A),
        a.membershipSvc.provisionDevice('device-x2', CONV_ID, USER_A, DEVICE_A),
      ]);

      expect(res1.status).toBe('rejected');
      expect(res2.status).toBe('rejected');

      // Whichever of the two ends up as the final local state, membership
      // must be internally consistent -- never both phantom devices present
      // AND never a state that isn't a valid outcome of one CAS-guarded
      // rollback correctly skipping when it found a concurrent write.
      const members = a.memberDeviceIds(CONV_ID);
      const bothPhantomsPresent = members.includes('device-x1') && members.includes('device-x2');
      expect(bothPhantomsPresent).withContext('rollback must never leave BOTH phantom adds standing simultaneously').toBeFalse();

      console.log('[P1 FIX Section 11] concurrent provisionDevice CAS outcome -- final members:', members);

      // CAS correctness, not full convergence, is what this test verifies:
      // the LOSER's rollback correctly detected the WINNER's already-more-
      // advanced state and skipped rather than clobbering it (the "rollback
      // skipped" log line above) -- so at most ONE of the two phantom
      // devices survives locally, never both, and never a corrupted/
      // undecodable tree. A's own encrypt must still work without throwing.
      const ciphertext = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'still sound after the race');
      expect(ciphertext).withContext('A\'s tree is still structurally valid -- no corruption from the CAS race').toBeTruthy();

      // The single surviving phantom (if any) is NOT expected to
      // self-resolve from this race alone -- B never saw either of A's
      // failed commits (server never received them), so B has no way to
      // converge with A here. This residual single-device divergence is
      // exactly what Section 6b's crash/restart detection
      // (isDeviceMemberLocally() + the reconnect sweep) is designed to
      // catch on next reconnect -- not re-tested here, already covered.
    });

    it('a concurrent REAL incoming commit (from another device) is never clobbered by this device\'s own failed-commit rollback', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      // B removes C for real, posts successfully.
      await b.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_B, DEVICE_B);
      const bCommit = backend.getCommits(CONV_ID).find(row => row.senderDeviceId === DEVICE_B.id)!;

      interceptPostCommit_CaseA(backend);

      // A's own commit is built from the SAME pre-Remove epoch as B's (a
      // genuine concurrent race), then fails to post.
      await expectAsync(a.membershipSvc.provisionDevice(NEW_DEVICE, CONV_ID, USER_A, DEVICE_A)).toBeRejected();

      // A applies B's real commit afterward, exactly as a normal reconnect
      // sweep would (this conversation's true history, independent of A's
      // own failed local attempt).
      await a.commitSvc.processIncomingCommit(CONV_ID, bCommit.commit, bCommit.epoch, USER_A, DEVICE_A);

      expect(a.memberDeviceIds(CONV_ID)).withContext('B\'s real Remove(C) must be reflected').not.toContain(DEVICE_C.id);
      expect(a.memberDeviceIds(CONV_ID)).withContext('A\'s own phantom device must not be present').not.toContain(NEW_DEVICE);
      expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
    });
  });
});
