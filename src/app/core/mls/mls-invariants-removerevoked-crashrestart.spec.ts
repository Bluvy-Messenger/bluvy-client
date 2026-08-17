import { createCommit, encodeGroupState, encodeMlsMessage } from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { findLeafIndex } from 'ts-mls/ratchetTree.js';
import { FakeMlsBackend, Device, makeGroup, getCs, bytesToBase64 } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { PendingRemovalRecord } from './mls.types';

// P0 CRASH/RESTART FIX -- removeRevokedDeviceFromAllGroups() now survives a
// crash between its local optimistic write and postCommit() confirmation,
// via a pendingRemovals marker (mls.types.ts) written atomically with the
// Group State (same storage.update() call) and resolved by
// recoverPendingRemovals() (mls-membership.service.ts), invoked from
// DeviceProvisioningService.checkAndProvisionOnConnect() on reconnect.
//
// See the read-only crash/restart audit for the full design rationale --
// in particular, epoch equality alone is NEVER trusted as proof (confirmed
// there that a completely unrelated real commit from another device can
// coincidentally land at the exact same target epoch number); safety comes
// from the rollback ALWAYS being followed by a genuine server round trip
// via catchUpMissedCommits(), never from the epoch comparison by itself.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const USER_C: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet (to revoke)', platform: 'web' };
const CONV_ID = 'conv-removerevoked-crashrestart';

// Faithfully replicates ONLY removeRevokedDeviceFromAllGroups()'s optimistic
// write, INCLUDING the pendingRemovals marker, in the same shape as the
// real code's single storage.update() call -- WITHOUT ever calling
// postCommit(). Harness-level stand-in for "the process died right after
// storage.update() resolved, before postCommit() was even attempted."
async function simulateOptimisticRemoveWithMarker(a: Device, conversationId: string, revokedDeviceId: string): Promise<{ previousEpoch: number; newEpoch: number; previousStateB64: string }> {
  const cs = await getCs();
  const clientState = a.getClientState(conversationId);
  const previousEpoch = Number(clientState.groupContext.epoch);
  const previousStateB64 = a.getGroupStateB64(conversationId)!;
  const members = getGroupMembers(clientState);
  const dec = new TextDecoder();
  const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
    m.credential.credentialType === 'basic' && dec.decode(m.credential.identity).endsWith(`#${revokedDeviceId}`));
  if (!targetMember) throw new Error('harness: revoked device not found');
  const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember);
  if (leafIndex === undefined) throw new Error('harness: leaf not found');

  const removeProposal = { proposalType: 'remove' as const, remove: { removed: leafIndex } };
  const { newState } = await createCommit(
    { state: clientState, cipherSuite: cs },
    { extraProposals: [removeProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  const newEpoch = Number(newState.groupContext.epoch);
  const newStateB64 = bytesToBase64(encodeGroupState(newState));

  a.seedGroupState(conversationId, newStateB64);
  const marker: PendingRemovalRecord = { revokedDeviceId, previousEpoch, previousStateB64, newEpoch };
  a.seedPendingRemoval(conversationId, marker);

  return { previousEpoch, newEpoch, previousStateB64 };
}

function restartDevice(backend: FakeMlsBackend, user: UserProfile, device: DeviceInfo, crashed: Device): Device {
  const fresh = new Device(backend, user, device);
  const raw = crashed.storage.raw(crashed.scope);
  if (raw) fresh.storage.seed(fresh.scope, raw);
  return fresh;
}

describe('P0 CRASH/RESTART FIX -- removeRevokedDeviceFromAllGroups() pendingRemovals marker', () => {

  // ── Section 1: nominal -- marker written during, cleared after success ──
  it('marker exists at the moment postCommit() is called, and is gone once removeRevokedDeviceFromAllGroups() resolves successfully', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);

    let markerSeenDuringPostCommit: PendingRemovalRecord | undefined;
    const original = backend.postCommit.bind(backend);
    backend.postCommit = (async (...args: Parameters<typeof backend.postCommit>) => {
      markerSeenDuringPostCommit = a.getPendingRemoval(CONV_ID);
      return original(...args);
    }) as typeof backend.postCommit;

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

    expect(markerSeenDuringPostCommit).withContext('the marker was present, atomically with the Group State write, BEFORE the network call').toBeDefined();
    expect(markerSeenDuringPostCommit?.revokedDeviceId).toBe(DEVICE_C.id);
    expect(markerSeenDuringPostCommit?.newEpoch).toBe(2);
    expect(a.getPendingRemoval(CONV_ID)).withContext('cleared after a successful commit').toBeUndefined();
  });

  // ── 1. Case A: crash before server ever received anything ────────────
  describe('1. Case A: crash before server', () => {
    it('N local / N server -> Remove -> local N+1+marker -> CRASH -> restart -> server still N -> recovery -> local N / server N / marker gone', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);
      const epochBefore = a.epoch(CONV_ID);
      const commitsBefore = backend.getCommits(CONV_ID).length;

      await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id); // crash: nothing sent to the server at all

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      expect(a2.epoch(CONV_ID)).toBe(epochBefore + 1); // phantom state survived the "restart"
      expect(a2.getPendingRemoval(CONV_ID)).toBeDefined();

      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      expect(a2.epoch(CONV_ID)).withContext('rolled back to the last confirmed epoch').toBe(epochBefore);
      expect(backend.getCommits(CONV_ID).length).withContext('server still untouched').toBe(commitsBefore);
      expect(a2.getPendingRemoval(CONV_ID)).withContext('marker cleared').toBeUndefined();
      expect(a2.memberDeviceIds(CONV_ID)).withContext('C never actually revoked').toContain(DEVICE_C.id);

      // 13. retry after rollback genuinely performs the Remove.
      await a2.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);
      expect(a2.memberDeviceIds(CONV_ID)).not.toContain(DEVICE_C.id);
      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a2.memberDeviceIds(CONV_ID).sort());
    });

    // 11. crypto Case A.
    it('cryptographic proof: D decrypt SUCCESS before -> phantom local -> FAILURE -> after rollback -> SUCCESS again', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      const before = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'avant');
      expect(await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, before)).withContext('AVANT: C decrypts SUCCESS').toBe('avant');

      const { newEpoch, previousStateB64 } = await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id);
      const during = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'pendant');
      await expectAsync(
        c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, during),
      ).withContext('PENDANT: C decrypt FAILS -- the exact window this fix closes').toBeRejected();

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      expect(a2.getPendingRemoval(CONV_ID)?.newEpoch).toBe(newEpoch);
      expect(a2.getPendingRemoval(CONV_ID)?.previousStateB64).toBe(previousStateB64);
      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      const after = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres');
      expect(await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, after)).withContext('APRÈS: C decrypts SUCCESS again, automatically').toBe('apres');
    });

    // 14. répétition Case A 100x.
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

        await simulateOptimisticRemoveWithMarker(a, CONV_ID, `device-c-${i}`);
        const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
        await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

        const diverged = a2.epoch(CONV_ID) !== epochBefore || backend.getCommits(CONV_ID).length !== commitsBefore;
        if (diverged) divergenceCount++;
      }
      console.log(`[P0 CRASH FIX] Case A divergence in ${divergenceCount}/100 repetitions (expected: 0).`);
      expect(divergenceCount).toBe(0);
    }, 120000);
  });

  // ── 2. Case B: server accepted, crash before reconciliation ───────────
  describe('2. Case B: server accepted, crash before reconciliation', () => {
    async function postRealRemoveDirectlyToServer(a: Device): Promise<{ newEpoch: number; previousStateB64: string; N: number }> {
      const cs = await getCs();
      const clientState = a.getClientState(CONV_ID);
      const N = Number(clientState.groupContext.epoch);
      const previousStateB64 = a.getGroupStateB64(CONV_ID)!;
      const members = getGroupMembers(clientState);
      const dec = new TextDecoder();
      const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
        m.credential.credentialType === 'basic' && dec.decode(m.credential.identity).endsWith(`#${DEVICE_C.id}`))!;
      const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember)!;
      const removeProposal = { proposalType: 'remove' as const, remove: { removed: leafIndex } };
      const { newState, commit } = await createCommit(
        { state: clientState, cipherSuite: cs },
        { extraProposals: [removeProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );
      const newEpoch = Number(newState.groupContext.epoch);
      const newStateB64 = bytesToBase64(encodeGroupState(newState));
      const commitB64 = bytesToBase64(encodeMlsMessage(commit));

      a.seedGroupState(CONV_ID, newStateB64);
      const marker: PendingRemovalRecord = { revokedDeviceId: DEVICE_C.id, previousEpoch: N, previousStateB64, newEpoch };
      a.seedPendingRemoval(CONV_ID, marker);
      // Server DID receive and store it (Case B) -- crash happens before A ever learns this.
      await a.backend.postCommit(CONV_ID, DEVICE_A.id, commitB64, N);

      return { newEpoch, previousStateB64, N };
    }

    it('server accepted the Remove -> CRASH before reconciliation -> restart -> recovery adopts the real commit -> exactly ONE commit, C genuinely revoked', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);
      const commitsBefore = backend.getCommits(CONV_ID).length;

      await postRealRemoveDirectlyToServer(a);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).withContext('exactly ONE commit -- no duplicate from recovery').toBe(commitsBefore + 1);
      expect(a2.epoch(CONV_ID)).toBe(2);
      expect(a2.memberDeviceIds(CONV_ID)).withContext('C genuinely removed').not.toContain(DEVICE_C.id);
      expect(a2.getPendingRemoval(CONV_ID)).toBeUndefined();

      const applied = await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
      expect(applied).toBe(1);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a2.memberDeviceIds(CONV_ID).sort());
    });

    // 12. crypto Case B.
    it('cryptographic proof: after recovery, C\'s OLD session decrypt is FAILURE (genuinely revoked), survivors decrypt SUCCESS', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      await postRealRemoveDirectlyToServer(a);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B); // B independently catches up on the real commit -- never touched by recovery

      const fromA = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'C is genuinely gone');
      expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).withContext('survivor B decrypt SUCCESS').toBe('C is genuinely gone');
      await expectAsync(
        c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA),
      ).withContext('C decrypt FAILURE -- stays revoked after recovery, exactly like a normal revocation').toBeRejected();
    });

    // 15. répétition Case B.
    it('Case B reconciles identically across 20 repetitions -- exactly one commit each time, C always genuinely revoked', async () => {
      for (let i = 0; i < 20; i++) {
        const backend = new FakeMlsBackend();
        const a = new Device(backend, USER_A, DEVICE_A);
        const b = new Device(backend, USER_B, DEVICE_B);
        const c = new Device(backend, USER_C, { ...DEVICE_C, id: `device-c-caseb-${i}` });
        await makeGroup(CONV_ID, backend, a, [b, c]);
        const commitsBefore = backend.getCommits(CONV_ID).length;

        const cs = await getCs();
        const clientState = a.getClientState(CONV_ID);
        const N = Number(clientState.groupContext.epoch);
        const previousStateB64 = a.getGroupStateB64(CONV_ID)!;
        const members = getGroupMembers(clientState);
        const dec = new TextDecoder();
        const targetMember = members.find((m: ReturnType<typeof getGroupMembers>[number]) =>
          m.credential.credentialType === 'basic' && dec.decode(m.credential.identity).endsWith(`#device-c-caseb-${i}`))!;
        const leafIndex = findLeafIndex(clientState.ratchetTree, targetMember)!;
        const removeProposal = { proposalType: 'remove' as const, remove: { removed: leafIndex } };
        const { newState, commit } = await createCommit(
          { state: clientState, cipherSuite: cs },
          { extraProposals: [removeProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
        );
        const newEpoch = Number(newState.groupContext.epoch);
        a.seedGroupState(CONV_ID, bytesToBase64(encodeGroupState(newState)));
        a.seedPendingRemoval(CONV_ID, { revokedDeviceId: `device-c-caseb-${i}`, previousEpoch: N, previousStateB64, newEpoch });
        await backend.postCommit(CONV_ID, DEVICE_A.id, bytesToBase64(encodeMlsMessage(commit)), N);

        const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
        await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

        expect(backend.getCommits(CONV_ID).length).withContext(`rep ${i}: exactly one commit`).toBe(commitsBefore + 1);
        expect(a2.memberDeviceIds(CONV_ID)).not.toContain(`device-c-caseb-${i}`);
      }
    }, 60000);
  });

  // ── 3. Case C: same epoch, DIFFERENT real commit ──────────────────────
  it('3. Case C: currentEpoch === marker.newEpoch by coincidence -- a DIFFERENT real commit from B, not our Remove -- recovery converges on the REAL commit, never corrupts it', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);
    const N = a.epoch(CONV_ID);

    const { newEpoch } = await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id);
    expect(newEpoch).toBe(N + 1);

    const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
    expect(a2.epoch(CONV_ID)).toBe(N + 1); // phantom, matches marker.newEpoch

    // B, unaware A ever attempted anything (nothing was posted), performs
    // its own real operation from the server's TRUE current epoch (N).
    // Lands at EXACTLY the same epoch number as A's phantom write.
    await b.membershipSvc.provisionDevice('device-b-new', CONV_ID, USER_B, DEVICE_B);
    expect(backend.getCommits(CONV_ID).find(cm => cm.epoch === N)?.senderDeviceId).toBe(DEVICE_B.id);

    await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

    expect(a2.memberDeviceIds(CONV_ID)).withContext('reflects B\'s REAL commit').toContain('device-b-new');
    expect(a2.memberDeviceIds(CONV_ID)).withContext('C was NEVER actually revoked -- the phantom Remove left no trace').toContain(DEVICE_C.id);
    expect(a2.getPendingRemoval(CONV_ID)).toBeUndefined();

    const applied = await c.commitSvc.catchUpMissedCommits(CONV_ID, USER_C, DEVICE_C);
    expect(applied).toBe(1);
    expect(c.memberDeviceIds(CONV_ID).sort()).toEqual(a2.memberDeviceIds(CONV_ID).sort());

    const fromA = await a2.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-recovery, C never lost access');
    expect(await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_C, DEVICE_C, fromA)).toBe('post-recovery, C never lost access');
  });

  // ── 4. Case D: epoch strictly ahead -- obsolete marker ────────────────
  it('4. Case D: currentEpoch > marker.newEpoch -- marker correctly dropped as obsolete, groupStates NEVER touched', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);

    const { newEpoch, previousStateB64 } = await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id);

    // Two real commits land server-side while A is "crashed".
    await b.membershipSvc.provisionDevice('device-b-new-1', CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('device-b-new-2', CONV_ID, USER_B, DEVICE_B);

    // A real, valid, more-advanced state lands locally via an independent
    // legitimate path (NOT via the phantom tree, which would fail
    // membership verification -- see the read-only audit's structural
    // finding) BEFORE recovery gets a chance to run.
    const bystander = new Device(backend, USER_A, DEVICE_A);
    bystander.seedGroupState(CONV_ID, previousStateB64);
    await bystander.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
    const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
    a2.seedGroupState(CONV_ID, bystander.getGroupStateB64(CONV_ID)!);

    expect(a2.epoch(CONV_ID)).toBe(newEpoch + 1); // strictly ahead of marker.newEpoch
    const stateBeforeRecovery = a2.getGroupStateB64(CONV_ID);

    await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

    expect(a2.getGroupStateB64(CONV_ID)).withContext('Group State completely untouched').toBe(stateBeforeRecovery);
    expect(a2.getPendingRemoval(CONV_ID)).withContext('stale marker dropped').toBeUndefined();
    expect(a2.memberDeviceIds(CONV_ID)).toContain('device-b-new-1');
    expect(a2.memberDeviceIds(CONV_ID)).toContain('device-b-new-2');
    expect(a2.memberDeviceIds(CONV_ID)).withContext('C never actually revoked, correctly still present').toContain(DEVICE_C.id);
  });

  // ── 5. Multiple conversations ──────────────────────────────────────────
  describe('5. Multi-conversation', () => {
    it('conv CONFIRMED (real Remove already completed), conv CRASHED (phantom write + marker), conv UNTOUCHED (never touched) -- recovery acts ONLY on conv CRASHED', async () => {
      const CONV_CONFIRMED = 'conv-removerevoked-crashrestart-confirmed';
      const CONV_CRASHED = 'conv-removerevoked-crashrestart-crashed';
      const CONV_UNTOUCHED = 'conv-removerevoked-crashrestart-untouched';
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      // Three independent revoked-device identities, one per conversation
      // -- removeRevokedDeviceFromAllGroups(deviceId) only ever touches
      // conversations where THAT specific deviceId is a member, so this
      // naturally isolates each conversation's fate without needing to
      // "undo" a shared call.
      const cConfirmed = new Device(backend, USER_C, { id: 'device-c-confirmed', name: 'Tablet', platform: 'web' });
      const cCrashed = new Device(backend, USER_C, { id: 'device-c-crashed', name: 'Tablet', platform: 'web' });
      const cUntouched = new Device(backend, USER_C, { id: 'device-c-untouched', name: 'Tablet', platform: 'web' });
      await makeGroup(CONV_CONFIRMED, backend, a, [b, cConfirmed]);
      await makeGroup(CONV_CRASHED, backend, a, [b, cCrashed]);
      await makeGroup(CONV_UNTOUCHED, backend, a, [b, cUntouched]);

      // Conv CONFIRMED: a real Remove, already fully completed (as if this
      // happened in a prior loop iteration before the crash).
      await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-c-confirmed', USER_A, DEVICE_A);

      // Conv CRASHED: a fresh phantom Remove + marker, simulating the crash.
      await simulateOptimisticRemoveWithMarker(a, CONV_CRASHED, 'device-c-crashed');

      // Conv UNTOUCHED: never touched at all.

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      const confirmedStateBefore = a2.getGroupStateB64(CONV_CONFIRMED);
      const untouchedStateBefore = a2.getGroupStateB64(CONV_UNTOUCHED);

      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      expect(a2.getGroupStateB64(CONV_CONFIRMED)).withContext('conv CONFIRMED untouched by recovery').toBe(confirmedStateBefore);
      expect(a2.getGroupStateB64(CONV_UNTOUCHED)).withContext('conv UNTOUCHED untouched by recovery').toBe(untouchedStateBefore);
      expect(a2.memberDeviceIds(CONV_CONFIRMED)).withContext('CONFIRMED: C genuinely removed, unaffected by recovery').not.toContain('device-c-confirmed');
      expect(a2.memberDeviceIds(CONV_UNTOUCHED)).withContext('UNTOUCHED: C still present, never touched').toContain('device-c-untouched');
      expect(a2.getPendingRemoval(CONV_CRASHED)).withContext('CRASHED conv recovered, marker gone').toBeUndefined();
      expect(a2.memberDeviceIds(CONV_CRASHED)).withContext('CRASHED: phantom Remove rolled back -- C never actually revoked there').toContain('device-c-crashed');
    });
  });

  // ── 6-8. Concurrency ────────────────────────────────────────────────
  describe('6-8. Concurrency (CAS guard)', () => {
    it('6. Remove(D) + a genuine concurrent Commit from another device: CAS correctly resolves without a fork', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_C, { id: 'device-d1', name: 'Watch', platform: 'ios' });
      await makeGroup(CONV_ID, backend, a, [b, d]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(d.device.id, USER_A, DEVICE_A),
        b.membershipSvc.provisionDevice('device-b-new', CONV_ID, USER_B, DEVICE_B),
      ]);
      console.log('[P0 CRASH FIX Concurrency] Commit-concurrent A:', resA.status, '| B:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(b.memberDeviceIds(CONV_ID).sort());
      expect(a.getPendingRemoval(CONV_ID)).toBeUndefined();
    });

    it('7. concurrent recovery + Remove: recovery never clobbers a legitimate concurrent Remove of a DIFFERENT device', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      const e = new Device(backend, { did: 'did:plc:eve', handle: 'eve.test', displayName: 'Eve', avatarUrl: null }, { id: 'device-e1', name: 'Watch', platform: 'ios' });
      await makeGroup(CONV_ID, backend, a, [b, c, e]);

      await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id); // A's crashed attempt targeting C
      await b.membershipSvc.removeRevokedDeviceFromAllGroups('device-e1', USER_B, DEVICE_B); // B independently, genuinely revokes E
      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);

      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      expect(a2.memberDeviceIds(CONV_ID)).withContext('E correctly stays removed -- recovery never resurrects a REAL removal it wasn\'t responsible for').not.toContain('device-e1');
      expect(a2.getPendingRemoval(CONV_ID)).toBeUndefined();
    });

    it('8. Remove(D) + concurrent reprovision(D) (contradictory intents): resolves without a fork', async () => {
      const backend = new FakeMlsBackend();
      backend.delayRangeMs = [0, 5];
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const d = new Device(backend, USER_C, { id: 'device-d1', name: 'Watch', platform: 'ios' });
      await makeGroup(CONV_ID, backend, a, [b, d]);

      const [resA, resB] = await Promise.allSettled([
        a.membershipSvc.removeRevokedDeviceFromAllGroups(d.device.id, USER_A, DEVICE_A),
        b.membershipSvc.reprovisionLostStateDevice(d.device.id, CONV_ID, USER_B, DEVICE_B),
      ]);
      console.log('[P0 CRASH FIX Concurrency] Remove+reprovision A:', resA.status, '| B:', resB.status);

      await a.commitSvc.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A);
      await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);

      expect(a.memberDeviceIds(CONV_ID).sort()).withContext('A and B converge on the SAME outcome -- no fork').toEqual(b.memberDeviceIds(CONV_ID).sort());
    });
  });

  // ── 9. Idempotence ─────────────────────────────────────────────────────
  describe('9. Idempotence', () => {
    it('recovery -> recovery (back to back): no double commit, no member loss, no epoch regression', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);

      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);
      const epochAfterFirst = a2.epoch(CONV_ID);
      const membersAfterFirst = a2.memberDeviceIds(CONV_ID);
      const commitsAfterFirst = backend.getCommits(CONV_ID).length;

      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A); // no-op, nothing pending

      expect(a2.epoch(CONV_ID)).toBe(epochAfterFirst);
      expect(a2.memberDeviceIds(CONV_ID).sort()).toEqual(membersAfterFirst.sort());
      expect(backend.getCommits(CONV_ID).length).toBe(commitsAfterFirst);
    });

    // 10. crash pendant recovery.
    it('recovery -> crash (simulated: a second "restart" mid-flow) -> recovery: still converges cleanly, no duplication', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_C, DEVICE_C);
      await makeGroup(CONV_ID, backend, a, [b, c]);

      await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id);
      const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
      await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      const a3 = restartDevice(backend, USER_A, DEVICE_A, a2); // "crash during/after recovery", second restart
      const commitsBefore = backend.getCommits(CONV_ID).length;
      await a3.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A);

      expect(backend.getCommits(CONV_ID).length).toBe(commitsBefore);
      expect(a3.getPendingRemoval(CONV_ID)).toBeUndefined();
    });
  });

  // ── 16. No double Remove, across the full failure -> recovery -> retry chain ──
  it('16. no double Remove across failure -> recovery -> retry: exactly one leaf removed, exactly one real commit total', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_C, DEVICE_C);
    await makeGroup(CONV_ID, backend, a, [b, c]);
    const commitsBefore = backend.getCommits(CONV_ID).length;

    await simulateOptimisticRemoveWithMarker(a, CONV_ID, DEVICE_C.id); // crash
    const a2 = restartDevice(backend, USER_A, DEVICE_A, a);
    await a2.membershipSvc.recoverPendingRemovals(USER_A, DEVICE_A); // Case A rollback
    await a2.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A); // real retry

    expect(backend.getCommits(CONV_ID).length).withContext('exactly one real commit for the whole sequence').toBe(commitsBefore + 1);
    expect(a2.memberDeviceIds(CONV_ID).filter(id => id === DEVICE_C.id).length).toBe(0);
    expect(a2.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());
  });
});
