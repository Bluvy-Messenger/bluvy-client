import { HttpErrorResponse } from '@angular/common/http';
import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// PERMANENT REGRESSION SUITE — P1 fix: pendingReprovisions orphaned marker
// after clearConversationGroup() (409), the reprovision sibling of the
// genesis defect fixed in mls-audit-pendinggenesis-orphan-clearconversationgroup.investigation.spec.ts.
//
// Structural risk audit (this session) confirmed reprovisionLostStateDevice()'s
// 409 handler (mls-membership.service.ts) is byte-for-byte identical in
// shape to genesis's: it writes pendingReprovisions[conversationId] in the
// SAME optimistic storage.update() that later 409s, and clearConversationGroup()
// used to delete groupStates[conversationId] without ever touching that
// marker. recoverOnePendingReprovision() uses epoch equality alone as its
// rollback trigger, exactly like recoverOnePendingGenesis() -- reachable
// here MORE easily than genesis, since reprovision operates on an
// already-active group where commits happen continuously (every subsequent
// real commit from anyone is a fresh chance to coincidentally land at
// exactly marker.newEpoch, by construction of MLS's strictly-sequential
// per-conversation epoch counter).
//
// FIX: clearConversationGroup() now deletes pendingReprovisions[conversationId]
// (and pendingRemovals/pendingGenesises) in the same storage.update() as
// groupStates[conversationId] -- see mls-membership.service.ts.
//
// Real ts-mls crypto throughout, via testing/mls-multidevice-harness.ts.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-pendingreprovision-orphan';

// A+B real group, then A's own reprovision attempt (targeting B, as if B
// "lost its state") forced to a real 409.
async function triggerReal409(convId: string): Promise<{ backend: FakeMlsBackend; a: Device; b: Device }> {
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  await makeGroup(convId, backend, a, [b]);
  expect(a.epoch(convId)).toBe(1);

  backend.postCommit = (async () => {
    throw new HttpErrorResponse({ status: 409, error: { error: { code: 'EPOCH_GAP' } } });
  }) as typeof backend.postCommit;

  await expectAsync(a.membershipSvc.reprovisionLostStateDevice(DEVICE_B.id, convId, USER_A, DEVICE_A)).toBeRejected();

  return { backend, a, b };
}

describe('P1 FIX -- pendingReprovisions no longer orphaned after clearConversationGroup() (409)', () => {

  it('1. FIXED: a real reprovision 409 no longer leaves an orphaned pendingReprovisions marker', async () => {
    const { a } = await triggerReal409(CONV_ID);

    expect(a.getGroupStateB64(CONV_ID)).withContext('groupState absent after the 409').toBeUndefined();
    expect(a.getPendingReprovision(CONV_ID)).withContext('FIXED: the marker no longer survives the 409').toBeUndefined();
  });

  it('2. FIXED end-to-end: 409 -> no orphaned marker -> a real, independent reprovision-of-A converges cleanly, no phantom rollback, real crypto works both ways', async () => {
    const { backend, a, b } = await triggerReal409(CONV_ID);

    // Restore the real postCommit for everything that follows.
    const proto = Object.getPrototypeOf(backend);
    (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
    // Test-only: A's forced 409 short-circuited past postCommit()'s own
    // lock-release-on-success line, leaving the fake backend's server-side
    // commit lock stuck held by A -- release it directly (private field,
    // cast from the test, no harness FILE edit) so B's genuinely independent
    // recovery below isn't artificially blocked by A's failed attempt.
    (backend as unknown as { locks: Map<string, string> }).locks.delete(CONV_ID);

    // B, genuinely unaffected by A's failed attempt, independently notices A
    // "lost its state" and reprovisions it for real -- a real Remove(A's old
    // leaf)+Add(A fresh) commit, landing at exactly the epoch A's own failed
    // attempt's marker remembers as newEpoch (both are A's solo epoch-1
    // state's next real commit, by construction).
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B);
    a.seedOwnKeyPackage();

    const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
    expect(joined).withContext('A genuinely rejoins via a real Welcome').toBe('joined');
    expect(a.epoch(CONV_ID)).toBe(2);
    expect(a.getPendingReprovision(CONV_ID)).withContext('still no marker to collide with').toBeUndefined();

    const realStateAfterWelcomeB64 = a.getGroupStateB64(CONV_ID);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());

    // The REAL production entry point.
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    // FIXED: no marker survives to trigger a phantom rollback -- clean no-op.
    expect(a.getGroupStateB64(CONV_ID)).withContext('FIXED: no phantom rollback ever fires -- state unchanged').toBe(realStateAfterWelcomeB64);

    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres-correction-reprovision-a-vers-b');
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('apres-correction-reprovision-a-vers-b');
    const fromB = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'apres-correction-reprovision-b-vers-a');
    expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromB)).toBe('apres-correction-reprovision-b-vers-a');
  });

  it('3. répétition x20: le correctif est déterministe pour la reprovision -- jamais de marker orphelin, jamais de régression', async () => {
    for (let i = 0; i < 20; i++) {
      const convId = `conv-pendingreprovision-orphan-rep-${i}`;
      const { backend, a, b } = await triggerReal409(convId);

      expect(a.getPendingReprovision(convId)).withContext(`repetition ${i}: no orphaned marker`).toBeUndefined();

      const proto = Object.getPrototypeOf(backend);
      (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
      (backend as unknown as { locks: Map<string, string> }).locks.delete(convId);

      await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, convId, USER_B, DEVICE_B);
      a.seedOwnKeyPackage();
      const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(convId, USER_A, DEVICE_A);
      expect(joined).withContext(`repetition ${i}`).toBe('joined');

      const realStateB64 = a.getGroupStateB64(convId);
      await a.coordinator.ensureGroupReady(convId, USER_B.did, USER_A, DEVICE_A);
      expect(a.getGroupStateB64(convId)).withContext(`repetition ${i}: no regression`).toBe(realStateB64);

      const fromA = await a.messageCryptoSvc.encryptMessage(convId, USER_A, DEVICE_A, `msg-${i}`);
      expect(await b.messageCryptoSvc.decryptMessage(convId, USER_B, DEVICE_B, fromA)).withContext(`repetition ${i}: real crypto works`).toBe(`msg-${i}`);
    }
  });
});
