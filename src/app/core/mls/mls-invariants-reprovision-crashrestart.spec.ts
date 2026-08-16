import {
  createCommit, decodeMlsMessage, encodeGroupState, type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { findLeafIndex } from 'ts-mls/ratchetTree.js';
import {
  FakeMlsBackend, Device, makeGroup, getCs, bytesToBase64, base64ToBytes,
  generateDeviceIdentityKeyPackage,
} from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { PendingReprovisionRecord } from './mls.types';

// P1 CRASH/RESTART FIX -- reprovisionLostStateDevice() now survives a crash
// between its local optimistic write and postCommit() confirmation, via a
// pendingReprovisions marker (mls.types.ts) written atomically with the
// Group State (same storage.update() call) and resolved by
// recoverPendingReprovisions() (mls-membership.service.ts), invoked from
// DeviceProvisioningService.checkAndProvisionOnConnect() on reconnect.
//
// See the design report (Option G) for the full architecture rationale.
// This file exercises recoverPendingReprovisions() directly (the harness
// wires MlsMembershipService/MlsCommitService/MlsMessageCryptoService only,
// not the full DeviceProvisioningService/MlsCoordinatorService stack) --
// the one-line delegate wiring checkAndProvisionOnConnect() -> coordinator
// -> mlsSvc -> membershipSvc is a thin, already type-checked pass-through,
// not independently re-verified here.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_D: UserProfile = { did: 'did:plc:dave', handle: 'dave.test', displayName: 'Dave', avatarUrl: null };
const DEVICE_D: DeviceInfo = { id: 'device-d1', name: 'Old Phone', platform: 'android' };
const CONV_ID = 'conv-reprovision-crashrestart';

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

// Faithfully replicates reprovisionLostStateDevice()'s ENTIRE optimistic
// write, INCLUDING the pendingReprovisions marker, in the same shape as the
// real code's single storage.update() call -- WITHOUT ever calling
// postCommit(). This is the harness-level stand-in for "the process died
// right after storage.update() resolved, before postCommit() was even
// attempted" -- exactly crash point 2/3 from the design report.
async function simulateOptimisticRemoveAddWithMarker(a: Device, conversationId: string, staleDeviceId: string): Promise<{ previousEpoch: number; newEpoch: number; previousStateB64: string }> {
  const cs = await getCs();
  const clientState = a.getClientState(conversationId);
  const previousEpoch = Number(clientState.groupContext.epoch);
  const previousStateB64 = a.getGroupStateB64(conversationId)!;
  const members = getGroupMembers(clientState);
  const dec = new TextDecoder();
  const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
    m.credential.credentialType === 'basic' && dec.decode(m.credential.identity).endsWith(`#${staleDeviceId}`));
  if (!targetMember) throw new Error('harness: stale device not found');
  const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember);
  if (leafIndex === undefined) throw new Error('harness: leaf not found');

  const kp = await generateDeviceIdentityKeyPackage(staleDeviceId);
  const decodedKP = decodeMlsMessage(base64ToBytes(kp.keyPackage), 0)?.[0];
  if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') throw new Error('harness: bad key package');

  const removeProposal = { proposalType: 'remove' as const, remove: { removed: leafIndex } };
  const addProposal: ProposalAdd = { proposalType: 'add', add: { keyPackage: decodedKP.keyPackage } };
  const { newState } = await createCommit(
    { state: clientState, cipherSuite: cs },
    { extraProposals: [removeProposal, addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  const newEpoch = Number(newState.groupContext.epoch);
  const newStateB64 = bytesToBase64(encodeGroupState(newState));

  a.seedGroupState(conversationId, newStateB64);
  const marker: PendingReprovisionRecord = { staleDeviceId, previousEpoch, previousStateB64, newEpoch };
  a.seedPendingReprovision(conversationId, marker);

  return { previousEpoch, newEpoch, previousStateB64 };
}

// "Process restart": a fresh Device instance for the SAME identity, storage
// seeded from what the crashed instance durably wrote.
function restartDevice(backend: FakeMlsBackend, user: UserProfile, device: DeviceInfo, crashed: Device): Device {
  const fresh = new Device(backend, user, device);
  const raw = crashed.storage.raw(crashed.scope);
  if (raw) fresh.storage.seed(fresh.scope, raw);
  return fresh;
}

describe('P1 CRASH/RESTART FIX -- reprovisionLostStateDevice() pendingReprovisions marker', () => {

  // ── Section 1: nominal -- marker written during, cleared after success ──
  describe('Section 1: nominal flow', () => {
    it('marker exists at the moment postCommit() is called, and is gone once reprovisionLostStateDevice() resolves successfully', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      let markerSeenDuringPostCommit: PendingReprovisionRecord | undefined;
      const original = backend.postCommit.bind(backend);
      backend.postCommit = (async (...args: Parameters<typeof backend.postCommit>) => {
        markerSeenDuringPostCommit = a.getPendingReprovision(CONV_ID);
        return original(...args);
      }) as typeof backend.postCommit;

      await a.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_A, DEVICE_A);

      expect(markerSeenDuringPostCommit).withContext('the marker was present, atomically with the Group State write, BEFORE the network call').toBeDefined();
      expect(markerSeenDuringPostCommit?.staleDeviceId).toBe(DEVICE_D.id);
      expect(markerSeenDuringPostCommit?.newEpoch).toBe(2);
      expect(a.getPendingReprovision(CONV_ID)).withContext('cleared after a successful commit').toBeUndefined();
    });
  });

  // ── Section 2: atomicity ─────────────────────────────────────────────
  describe('Section 2: atomicity (marker and Group State never exist independently)', () => {
    it('the simulated crash write leaves BOTH the phantom Group State AND the marker present together, with matching epochs', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);
      const epochBefore = a.epoch(CONV_ID);

      const { previousEpoch, newEpoch, previousStateB64 } = await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);

      expect(a.epoch(CONV_ID)).withContext('phantom Group State present').toBe(epochBefore + 1);
      const marker = a.getPendingReprovision(CONV_ID);
      expect(marker).withContext('marker present').toBeDefined();
      expect(marker?.previousEpoch).toBe(previousEpoch);
      expect(marker?.newEpoch).toBe(newEpoch);
      expect(marker?.previousStateB64).toBe(previousStateB64);
      expect(marker?.staleDeviceId).toBe(DEVICE_D.id);
    });
  });

  // ── Section 3: Case A after crash (§9 of the task) ──────────────────
  describe('Section 3: Case A after crash -- server never received the commit', () => {
    it('N local / N server -> reprovision -> local N+1+marker -> CRASH -> restart -> server still N -> recovery -> local N / server N / marker gone', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);
      const epochBefore = a.epoch(CONV_ID);
      const commitsBefore = backend.getCommits(CONV_ID).length;

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id); // crash: nothing sent to the server at all

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      expect(a2.epoch(CONV_ID)).toBe(epochBefore + 1); // phantom state survived the "restart"
      expect(a2.getPendingReprovision(CONV_ID)).toBeDefined();

      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.epoch(CONV_ID)).withContext('rolled back to the last confirmed epoch').toBe(epochBefore);
      expect(backend.getCommits(CONV_ID).length).withContext('server still untouched').toBe(commitsBefore);
      expect(a2.getPendingReprovision(CONV_ID)).withContext('marker cleared').toBeUndefined();

      // D's OLD session works again -- crypto proof, not just epoch bookkeeping.
      const fromA = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'after recovery');
      expect(await d.messageCryptoSvc.decryptMessage(CONV_ID, USER_D, DEVICE_D, fromA)).withContext('D old session decrypts SUCCESS').toBe('after recovery');

      // A fresh reprovisioning now works end-to-end.
      await a2.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_A, DEVICE_A);
      expect(a2.memberDeviceIds(CONV_ID)).toContain(DEVICE_D.id);
      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a2.memberDeviceIds(CONV_ID).sort());
    });
  });

  // ── Section 4: Case B after crash (§10 of the task) ─────────────────
  describe('Section 4: Case B after crash -- server accepted, crash before reconciliation', () => {
    it('server accepts the Remove+Add -> CRASH before reconciliation -> restart -> recovery adopts the real commit -> exactly ONE commit, all parties converge', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);
      const commitsBefore = backend.getCommits(CONV_ID).length;

      // Simulate the write, THEN post the exact same commit to the server
      // directly (standing in for "postCommit() was in flight and the
      // server processed it" -- the crash happens before the response, and
      // therefore before reconcileAfterPostCommitFailure/marker-clearing
      // ever runs).
      const cs = await getCs();
      const clientState = a.getClientState(CONV_ID);
      const previousEpoch = Number(clientState.groupContext.epoch);
      const previousStateB64 = a.getGroupStateB64(CONV_ID)!;
      const members = getGroupMembers(clientState);
      const dec = new TextDecoder();
      const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
        m.credential.credentialType === 'basic' && dec.decode(m.credential.identity).endsWith(`#${DEVICE_D.id}`))!;
      const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember)!;
      const kp = await generateDeviceIdentityKeyPackage(DEVICE_D.id);
      const decodedKP = decodeMlsMessage(base64ToBytes(kp.keyPackage), 0)?.[0];
      if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') throw new Error('bad kp');
      const removeProposal = { proposalType: 'remove' as const, remove: { removed: leafIndex } };
      const addProposal: ProposalAdd = { proposalType: 'add', add: { keyPackage: decodedKP.keyPackage } };
      const { newState, welcome, commit } = await createCommit(
        { state: clientState, cipherSuite: cs },
        { extraProposals: [removeProposal, addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );
      const newEpoch = Number(newState.groupContext.epoch);
      const newStateB64 = bytesToBase64(encodeGroupState(newState));
      const { encodeMlsMessage } = await import('ts-mls');
      const commitB64 = bytesToBase64(encodeMlsMessage(commit));
      const welcomeB64 = bytesToBase64(encodeMlsMessage({ version: 'mls10' as const, wireformat: 'mls_welcome' as const, welcome: welcome! }));

      a.seedGroupState(CONV_ID, newStateB64);
      a.seedPendingReprovision(CONV_ID, { staleDeviceId: DEVICE_D.id, previousEpoch, previousStateB64, newEpoch });
      // The server DID receive and store it (Case B) -- crash happens
      // before A ever learns this.
      await backend.postCommit(CONV_ID, DEVICE_A.id, commitB64, previousEpoch, [{ targetDeviceId: DEVICE_D.id, welcome: welcomeB64 }]);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).withContext('exactly ONE commit -- no duplicate from recovery').toBe(commitsBefore + 1);
      expect(a2.epoch(CONV_ID)).withContext('adopted the real server commit').toBe(2);
      expect(a2.memberDeviceIds(CONV_ID)).toContain(DEVICE_D.id);
      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();

      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);

      const dNew = new Device(backend, USER_D, DEVICE_D);
      await dNew.joinViaPendingWelcome(CONV_ID);

      const fromA = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-recovery Case B');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).withContext('B decrypts SUCCESS').toBe('post-recovery Case B');
      expect(await dNew.messageCryptoSvc.decryptMessage(CONV_ID, USER_D, DEVICE_D, fromA)).withContext('D new session decrypts SUCCESS').toBe('post-recovery Case B');
    });
  });

  // ── Section 5: crash at multiple moments (§11) ──────────────────────
  describe('Section 5: crash at the 7 named moments', () => {
    it('1. before storage.update() ever runs -- nothing persisted, no marker, ordinary retry', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);
      expect(a.getPendingReprovision(CONV_ID)).toBeUndefined();
      // No action taken -- this point in the real code has no persisted
      // side effect at all, already proven by the P1-A crash-consistency
      // "breakpoint (1)" test in mls-invariants-reprovision-divergence.spec.ts.
    });

    it('2/3. crash right after storage.update() (marker+state), before postCommit is even attempted -- covered by Section 3/4 above', () => {
      expect(true).toBe(true); // cross-reference only
    });

    it('4. during postCommit, server received nothing -- Case A, covered by Section 3', () => {
      expect(true).toBe(true);
    });

    it('5. during postCommit, server accepted -- Case B, covered by Section 4', () => {
      expect(true).toBe(true);
    });

    it('6. crash after the rollback+marker-deletion write, before catchUpMissedCommits() completes -- still safe (ordinary "possibly behind" state)', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);
      const epochBefore = a.epoch(CONV_ID);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);

      // Simulate catchUpMissedCommits() itself failing right after the
      // rollback+marker-delete write already landed (the atomic part is
      // done; only the network-bound reconciliation call fails) -- but
      // only for that FIRST call. callFake (not
      // returnValue(Promise.reject(...))) -- the latter constructs the
      // rejected promise eagerly, right here, before anything awaits it,
      // which Zone.js/Karma can flag as an unhandled rejection and fail
      // the test even though recoverOnePendingReprovision() does correctly
      // catch it once actually invoked below. The spy stays installed for
      // the rest of the test (spyOn doesn't auto-restore mid-test), so it
      // must fall through to the real implementation on later calls --
      // otherwise this test's OWN "ordinary catch-up later" call below
      // would also be faked to fail.
      const originalCatchUp = a2.commitSvc.catchUpMissedCommits.bind(a2.commitSvc);
      let catchUpCallCount = 0;
      spyOn(a2.commitSvc, 'catchUpMissedCommits').and.callFake((...args: Parameters<typeof originalCatchUp>) => {
        catchUpCallCount++;
        if (catchUpCallCount === 1) return Promise.reject(new Error('simulated: network died again, right after the rollback'));
        return originalCatchUp(...args);
      });

      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.epoch(CONV_ID)).withContext('rollback already landed and stands -- safe, ordinary state').toBe(epochBefore);
      expect(a2.getPendingReprovision(CONV_ID)).withContext('marker already cleared -- its job (making rollback possible) was already done').toBeUndefined();

      // An ordinary, unrelated catch-up later still works fine (proves
      // this state isn't stuck).
      const applied = await a2.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      expect(applied).toBe(0); // nothing to catch up on -- Case A, server never had it
    });

    it('7. restart with a marker already resolved by an earlier recovery -- pure idempotent no-op', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A); // first recovery resolves it

      const stateAfterFirstRecovery = a2.getGroupStateB64(CONV_ID);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A); // "second restart", marker already gone

      expect(a2.getGroupStateB64(CONV_ID)).withContext('no change -- pure no-op').toBe(stateAfterFirstRecovery);
      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();
    });
  });

  // ── Section 6: orphan marker (§12) ──────────────────────────────────
  describe('Section 6: orphan marker -- Group State already moved past what the marker describes', () => {
    it('recovery MUST NOT roll back or touch groupStates when currentEpoch !== marker.newEpoch -- only drops the stale marker', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id); // local now at epoch 2, marker.newEpoch = 2

      // Something else legitimately advances the conversation further
      // BEFORE any recovery runs -- current epoch (4) no longer matches
      // marker.newEpoch (2). Deliberately NOT simulated by calling
      // catchUpMissedCommits() directly on the crashed/phantom `a` itself:
      // that would apply a REAL commit against A's PHANTOM tree just
      // because the epoch NUMBERS happen to coincide -- exactly the
      // original, still-unfixed danger of calling catch-up against a
      // phantom-advanced state (confirmed empirically: doing so throws a
      // real CryptoVerificationError, "Could not verify membership",
      // since the phantom tree and the real epoch-2+ tree are simply
      // different trees that share a number by coincidence). Instead, D
      // (an independent device, never touched by A's phantom write) catches
      // up cleanly and its resulting valid state is what lands in A's
      // storage -- standing in for any LEGITIMATE mechanism (a backup
      // restore, a different session) that could bring a real, valid,
      // more-advanced tree into local storage without ever unsafely
      // catching up the phantom state itself.
      await b.membershipSvc.provisionDevice('device-b-new', CONV_ID, USER_B, DEVICE_B);
      await b.membershipSvc.provisionDevice('device-b-new-2', CONV_ID, USER_B, DEVICE_B);
      await d.commitSvc.catchUpMissedCommits(CONV_ID, USER_D, DEVICE_D);
      a.seedGroupState(CONV_ID, d.getGroupStateB64(CONV_ID)!);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      const stateBeforeRecovery = a2.getGroupStateB64(CONV_ID);
      expect(a2.epoch(CONV_ID)).toBe(3);
      expect(a2.getPendingReprovision(CONV_ID)?.newEpoch).toBe(2); // stale marker, orphaned

      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.getGroupStateB64(CONV_ID)).withContext('Group State completely untouched -- NEVER roll back over a more recent state').toBe(stateBeforeRecovery);
      expect(a2.epoch(CONV_ID)).toBe(3);
      expect(a2.getPendingReprovision(CONV_ID)).withContext('stale marker dropped').toBeUndefined();
      expect(a2.memberDeviceIds(CONV_ID)).withContext('the newer, real member is still there').toContain('device-b-new');
    });
  });

  // ── Section 7: concurrency (§13) ────────────────────────────────────
  describe('Section 7: concurrency -- recovery never clobbers a more recent state', () => {
    it('recovery + concurrent unrelated Commit: the marker is dropped, the concurrent Commit\'s effect survives untouched', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      await b.membershipSvc.provisionDevice('device-b-concurrent', CONV_ID, USER_B, DEVICE_B);
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.memberDeviceIds(CONV_ID)).toContain('device-b-concurrent');
      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();
    });

    it('recovery + concurrent Remove (of D itself): marker dropped, D correctly stays removed, no resurrection', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      // B independently revokes D outright (unrelated to A's crashed
      // reprovision attempt, which never reached the server).
      await b.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_D.id, USER_B, DEVICE_B);
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.memberDeviceIds(CONV_ID)).withContext('D stays removed -- recovery must not resurrect it via previousStateB64').not.toContain(DEVICE_D.id);
      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();
    });

    it('recovery + concurrent Update (provisionDevice() stand-in, same substitution convention as mls-invariants-remove-update.spec.ts)', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      await b.membershipSvc.provisionDevice('device-b-update-stand-in', CONV_ID, USER_B, DEVICE_B);
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();
      const fromA = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-concurrent-update');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('post-concurrent-update');
    });

    it('recovery + a SECOND reprovision of D that already resolved it: marker dropped, no double Remove+Add', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id); // A's crashed attempt, marker for epoch 2
      // B, unaware of A's crash, independently (and successfully) reprovisions D too.
      await b.membershipSvc.reprovisionLostStateDevice(DEVICE_D.id, CONV_ID, USER_B, DEVICE_B);
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      const membersBefore = a2.memberDeviceIds(CONV_ID);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(a2.memberDeviceIds(CONV_ID).sort()).withContext('B\'s real reprovision stands untouched -- no rollback, no double Remove+Add').toEqual(membersBefore.sort());
      expect(a2.memberDeviceIds(CONV_ID).filter(id => id === DEVICE_D.id).length).withContext('D has exactly one leaf, not a duplicate from a clobbered rollback').toBe(1);
      expect(a2.getPendingReprovision(CONV_ID)).toBeUndefined();
    });
  });

  // ── Section 8: idempotence (§15) ─────────────────────────────────────
  describe('Section 8: idempotence', () => {
    it('recovery -> recovery (back to back): no double commit, no double Welcome, no member loss, no epoch regression', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);

      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);
      const epochAfterFirst = a2.epoch(CONV_ID);
      const membersAfterFirst = a2.memberDeviceIds(CONV_ID);
      const commitsAfterFirst = backend.getCommits(CONV_ID).length;

      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A); // no-op, nothing pending

      expect(a2.epoch(CONV_ID)).withContext('no epoch regression').toBe(epochAfterFirst);
      expect(a2.memberDeviceIds(CONV_ID).sort()).withContext('no member loss').toEqual(membersAfterFirst.sort());
      expect(backend.getCommits(CONV_ID).length).withContext('no double commit').toBe(commitsAfterFirst);
    });

    it('recovery -> crash -> recovery (a second "restart" after the first recovery already resolved things): still a clean no-op', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_D, DEVICE_D);
      await makeGroup(CONV_ID, backend, a, [b, d]);

      await simulateOptimisticRemoveAddWithMarker(a, CONV_ID, DEVICE_D.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      const a3 = restartDevice(backend, USER_A, DEVICE_A, a2); // second "crash + restart"
      const commitsBefore = backend.getCommits(CONV_ID).length;
      await a3.membershipSvc.recoverPendingReprovisions(USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).toBe(commitsBefore);
      expect(a3.getPendingReprovision(CONV_ID)).toBeUndefined();
    });
  });
});
