import { FakeMlsBackend, Device } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// P2 FIX -- ensureGroupReady() now catches up an already-confirmed member
// that simply missed later commits (see mls.service.ts, the
// `getGroupMembers(existingClientState).length > 1` branch).
//
// Two DISTINCT findings came out of the original read-only audit:
//
// CAS 1 (still true, deliberately NOT changed in this task):
//   MlsCoordinatorService.encryptMessage() itself has no readiness guard
//   (no ensureGroupReady(), no barrier.wait(), no isConversationReady()) --
//   it delegates straight to MlsService.encryptMessage() ->
//   MlsMessageCryptoService.encryptMessage(), which only checks that SOME
//   ClientState exists for the conversation, nothing about its freshness.
//   Calling coordinator.encryptMessage() DIRECTLY, bypassing
//   ensureGroupReady() entirely, still produces a message a member who
//   joined during an outage can never decrypt -- this is an accepted,
//   intentional characteristic of encryptMessage() as a low-level
//   primitive (see the audit's §12 architectural conclusion), not
//   something this task fixes.
//
// CAS 2 (the actual bug, now fixed): the REAL production call pattern --
// every real call site calls `await coordinator.ensureGroupReady(...)`
// immediately before `coordinator.encryptMessage(...)` (see
// conversation.page.ts:395-405 etc.) -- did NOT protect against this,
// because ensureGroupReady()'s "already confirmed" fast path only checked
// for a pending Welcome (the "group was reset elsewhere" case), never
// catchUpMissedCommits() (the "confirmed member simply behind" case).
// That is what's fixed here.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const DEVICE_C: DeviceInfo = { id: 'device-b2', name: 'Tablet', platform: 'android' }; // B's SECOND device
const CONV_ID = 'conv-audit-encryptnoguard';

describe('P2 FIX -- ensureGroupReady() catches up an already-confirmed member that missed commits', () => {

  it('CAS 1 (unchanged, intentional): calling encryptMessage() DIRECTLY without ensureGroupReady() first still produces a ciphertext a member who joined during the outage cannot decrypt -- encryptMessage() remains a low-level primitive by design, not fixed in this task', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_B, DEVICE_C); // B's second device, joins AFTER this point
    backend.registerParticipant(USER_B.did, DEVICE_B.id);
    await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
    await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);
    await c.mlsSvc.initializeForSession(USER_B, DEVICE_C);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    await b.joinViaPendingWelcome(CONV_ID);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).toBe(1);
    expect(Number(b.getClientState(CONV_ID).groupContext.epoch)).toBe(1);

    await b.membershipSvc.provisionDevice(DEVICE_C.id, CONV_ID, USER_B, DEVICE_B);
    await c.joinViaPendingWelcome(CONV_ID);
    expect(backend.getCommits(CONV_ID).length).toBe(2);
    expect(Number(b.getClientState(CONV_ID).groupContext.epoch)).toBe(2);
    expect(Number(c.getClientState(CONV_ID).groupContext.epoch)).toBe(2);

    expect(Number(a.getClientState(CONV_ID).groupContext.epoch))
      .withContext('A must still be at the OLD epoch -- never processed the commit that added C')
      .toBe(1);

    // Direct call, deliberately bypassing ensureGroupReady() entirely.
    const ciphertext = await a.coordinator.encryptMessage(CONV_ID, 'stale epoch message', USER_A, DEVICE_A);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).toBe(1); // encrypting does not itself advance the epoch

    let cThrew: unknown;
    try {
      await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_C, ciphertext);
    } catch (err) {
      cThrew = err;
    }
    expect(cThrew).withContext('C never had epoch-1 key material -- must be cryptographically unable to decrypt a message encrypted at epoch 1, regardless of any ensureGroupReady() fix, since this call never went through it').toBeDefined();

    // B (present since epoch 1, real commit progression, within the
    // default key-retention window) CAN still decrypt -- documents the
    // asymmetric real-world impact (existing members within the retention
    // window are unaffected; only members who joined during the outage are).
    const bResult = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);
    expect(bResult).toBe('stale epoch message');
  });

  it('CAS 2 (the actual fix): the REAL production pattern -- ensureGroupReady() then encryptMessage() -- must now catch A up to the current epoch, so C (who joined during the outage) can decrypt', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const c = new Device(backend, USER_B, DEVICE_C);
    backend.registerParticipant(USER_B.did, DEVICE_B.id);
    await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
    await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);
    await c.mlsSvc.initializeForSession(USER_B, DEVICE_C);

    // AVANT (documented for the record, per §10 of the correction request):
    // server = epoch 2, A = epoch 1, ensureGroupReady() used to return with
    // A still at epoch 1 -- A.encryptMessage() then produced a message
    // C.decryptMessage() rejected with "epoch too old". APRÈS (this test):
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    await b.joinViaPendingWelcome(CONV_ID);
    await b.membershipSvc.provisionDevice(DEVICE_C.id, CONV_ID, USER_B, DEVICE_B);
    await c.joinViaPendingWelcome(CONV_ID);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).toBe(1); // A still stale before the fixed call

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(Number(a.getClientState(CONV_ID).groupContext.epoch))
      .withContext('ensureGroupReady() must now catch A up to the current server epoch before returning')
      .toBe(2);
    expect(a.coordinator.isConversationReady(CONV_ID)).toBeTrue();
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id, DEVICE_C.id].sort());

    const ciphertext = await a.coordinator.encryptMessage(CONV_ID, 'caught up, real message', USER_A, DEVICE_A);
    const decrypted = await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_C, ciphertext);
    expect(decrypted).withContext('C must now be able to decrypt -- A caught up to the epoch C joined at').toBe('caught up, real message');

    // Both directions, both members.
    const fromC = await c.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_C, 'reply from C');
    expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromC)).toBe('reply from C');
  });

  it('no missed commits: ensureGroupReady() is a true no-op for an already-current confirmed member -- no new Commit, no new Welcome, byte-identical state', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    backend.registerParticipant(USER_B.did, DEVICE_B.id);
    await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
    await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    await b.joinViaPendingWelcome(CONV_ID);

    const commitsBefore = backend.getCommits(CONV_ID).length;
    const stateBefore   = a.getGroupStateB64(CONV_ID);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(backend.getCommits(CONV_ID).length).withContext('no new Commit created just to "catch up" when already current').toBe(commitsBefore);
    expect(a.getGroupStateB64(CONV_ID)).withContext('byte-identical local state -- catchUpMissedCommits() found 0 commits and did not touch storage').toBe(stateBefore);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).toBe(1);
  });

  it('multiple missed commits (epoch 1 -> 2 -> 3 -> 4): ensureGroupReady() converges A all the way to the current epoch in one call', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const extraDevices = [
      { id: 'device-b-multi2', name: 'Tablet', platform: 'android' as const },
      { id: 'device-b-multi3', name: 'Desktop', platform: 'web' as const },
      { id: 'device-b-multi4', name: 'Watch', platform: 'android' as const },
    ];
    backend.registerParticipant(USER_B.did, DEVICE_B.id);
    await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
    await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A); // epoch 0 -> 1
    await b.joinViaPendingWelcome(CONV_ID);

    const lastDevices: Device[] = [];
    for (const info of extraDevices) {
      const d = new Device(backend, USER_B, info);
      await d.mlsSvc.initializeForSession(USER_B, info);
      await b.membershipSvc.provisionDevice(info.id, CONV_ID, USER_B, DEVICE_B); // epoch N -> N+1
      await d.joinViaPendingWelcome(CONV_ID);
      lastDevices.push(d);
    }

    expect(Number(b.getClientState(CONV_ID).groupContext.epoch)).toBe(4);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).withContext('A missed all 3 commits').toBe(1);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).withContext('must converge all the way to the current epoch, not just one step').toBe(4);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual(
      [DEVICE_A.id, DEVICE_B.id, ...extraDevices.map(d => d.id)].sort(),
    );

    // The hardest case: the device that joined at the LATEST epoch (4),
    // during the tail end of A's outage, must be able to decrypt.
    const newest = lastDevices[lastDevices.length - 1]!;
    const ciphertext = await a.coordinator.encryptMessage(CONV_ID, 'after multi-commit catchup', USER_A, DEVICE_A);
    const plaintext = await newest.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, newest.device, ciphertext);
    expect(plaintext).toBe('after multi-commit catchup');
  });

  it('idempotence: ensureGroupReady() x1/x2/x5/x10 all converge cleanly, no duplicate commits, no epoch regression -- with and without missed commits', async () => {
    for (const reps of [1, 2, 5, 10]) {
      const convId = `${CONV_ID}-idempotence-${reps}`;
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      backend.registerParticipant(USER_B.did, DEVICE_B.id);
      await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
      await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

      await a.coordinator.ensureGroupReady(convId, USER_B.did, USER_A, DEVICE_A);
      await b.joinViaPendingWelcome(convId);
      await b.membershipSvc.provisionDevice(DEVICE_C.id, convId, USER_B, DEVICE_B); // A misses this one
      const c = new Device(backend, USER_B, DEVICE_C);
      await c.mlsSvc.initializeForSession(USER_B, DEVICE_C);
      await c.joinViaPendingWelcome(convId);

      const commitsBeforeRepeats = backend.getCommits(convId).length;

      for (let i = 0; i < reps; i++) {
        await a.coordinator.ensureGroupReady(convId, USER_B.did, USER_A, DEVICE_A);
      }

      expect(Number(a.getClientState(convId).groupContext.epoch)).withContext(`reps=${reps}`).toBe(2);
      expect(backend.getCommits(convId).length).withContext(`reps=${reps}: no duplicate/extra commits from repeated calls`).toBe(commitsBeforeRepeats);

      const ciphertext = await a.coordinator.encryptMessage(convId, `idempotence check reps=${reps}`, USER_A, DEVICE_A);
      expect(await c.messageCryptoSvc.decryptMessage(convId, USER_B, DEVICE_C, ciphertext)).toBe(`idempotence check reps=${reps}`);
    }
  }, 30000);

  it('concurrency: ensureGroupReady() racing catchUpMissedCommits() for the same conversation converges without duplicate application or epoch regression', async () => {
    const backend = new FakeMlsBackend();
    backend.delayRangeMs = [0, 4];
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    backend.registerParticipant(USER_B.did, DEVICE_B.id);
    await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
    await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    await b.joinViaPendingWelcome(CONV_ID);
    await b.membershipSvc.provisionDevice(DEVICE_C.id, CONV_ID, USER_B, DEVICE_B);
    const c = new Device(backend, USER_B, DEVICE_C);
    await c.mlsSvc.initializeForSession(USER_B, DEVICE_C);
    await c.joinViaPendingWelcome(CONV_ID);
    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).toBe(1);

    const [r1, r2] = await Promise.allSettled([
      a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A),
      a.coordinator.catchUpMissedCommits(CONV_ID, USER_A, DEVICE_A),
    ]);
    console.log('[P2 fix concurrency] ensureGroupReady:', r1.status, '| catchUpMissedCommits:', r2.status);

    expect(Number(a.getClientState(CONV_ID).groupContext.epoch)).withContext('must converge to epoch 2 regardless of which call actually applied the commit').toBe(2);

    const ciphertext = await a.coordinator.encryptMessage(CONV_ID, 'post-race check', USER_A, DEVICE_A);
    expect(await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_C, ciphertext)).toBe('post-race check');
  });
});
