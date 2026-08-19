import { HttpErrorResponse } from '@angular/common/http';
import { FakeMlsBackend, Device } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// PERMANENT REGRESSION SUITE — P1 fix: pendingGenesises orphaned marker
// after clearConversationGroup() (409).
//
// Root cause (confirmed empirically before this fix, 20/20 repetitions,
// real ts-mls crypto): clearConversationGroup() (mls-membership.service.ts)
// removed groupStates[conversationId] on a genesis 409
// (mls.service.ts:473-478) but never touched pendingGenesises[conversationId]
// -- the marker survived as an orphan. A later, genuinely different real
// Welcome landing at exactly marker.newEpoch made recoverOnePendingGenesis()
// (mls.service.ts) wrongly treat the real, confirmed multi-member GroupState
// as its own phantom write, roll it back, then -- because the post-rollback
// reconciliation (catchUpMissedCommits()) failed with a real
// CryptoVerificationError that was silently swallowed -- ensureGroupReady()'s
// own self-healing retried genesis, got silently deduped by the server, and
// left the device holding a LOCALLY FABRICATED state never actually accepted
// server-side: a silent, permanent cryptographic fork (real
// `CryptoError: OperationError` observed when the other device tried to
// decrypt, despite identical epoch and membership on both sides).
//
// FIX: clearConversationGroup() now deletes pendingGenesises[conversationId]
// (and pendingReprovisions/pendingRemovals, covered by sibling spec files)
// in the SAME storage.update() callback as groupStates[conversationId] --
// see mls-membership.service.ts. No marker can survive to later collide.
//
// Every test below exercises the REAL production code path (real ts-mls
// crypto throughout, via testing/mls-multidevice-harness.ts). Test-only
// harness interactions, documented precisely (no harness FILE edits, no
// production code touched beyond the fix itself):
//
// 1. `backend.postCommit = (async () => { throw new HttpErrorResponse({
//    status: 409, error: { error: { code: 'EPOCH_GAP' } } }); })` -- the
//    exact interception pattern already established in this codebase's own
//    test suite (mls-invariants-ensuregroupready-crashrestart.spec.ts, test
//    "J. 409"), representing what Angular's HttpClient genuinely produces
//    for a non-2xx backend response.
//
// 2. `(backend as unknown as { initiatorClaims: Map<string,string> })
//    .initiatorClaims.delete(CONV_ID)` -- a direct manipulation of the fake
//    backend's OWN simplified initiator-claim map (private field, accessed
//    via cast from the test). Necessary because FakeMlsBackend.ensureGroup()
//    deliberately does not model the real backend's "nudge" mechanism that
//    releases a stuck initiator claim after a failed attempt -- without this,
//    no second device could ever become a real initiator for the same
//    conversationId after device A's failed attempt, making the "real
//    Welcome" step unreachable through any path at all.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-pendinggenesis-orphan';

// A's real Genesis Phase 2 attempt, forced to a real 409. Returns the
// backend/devices so the caller can drive the rest of the scenario.
async function triggerReal409(convId: string): Promise<{ backend: FakeMlsBackend; a: Device; b: Device }> {
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  backend.registerParticipant(USER_B.did, DEVICE_B.id);
  backend.registerParticipant(USER_A.did, DEVICE_A.id);
  await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
  await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

  backend.postCommit = (async () => {
    throw new HttpErrorResponse({ status: 409, error: { error: { code: 'EPOCH_GAP' } } });
  }) as typeof backend.postCommit;

  await expectAsync(a.mlsSvc.ensureGroupReady(convId, USER_B.did, USER_A, DEVICE_A)).toBeRejected();

  return { backend, a, b };
}

describe('P1 FIX -- pendingGenesises no longer orphaned after clearConversationGroup() (409)', () => {

  it('1. FIXED: a real Genesis 409 no longer leaves an orphaned pendingGenesises marker', async () => {
    const { a } = await triggerReal409(CONV_ID);

    expect(a.getGroupStateB64(CONV_ID)).withContext('groupState absent after the 409 (clearConversationGroup ran)').toBeUndefined();
    expect(a.getPendingGenesis(CONV_ID)).withContext('FIXED: the marker no longer survives the 409').toBeUndefined();
  });

  it('2. FIXED end-to-end: 409 -> no orphaned marker -> a real, independent Welcome converges cleanly, no phantom rollback, real crypto works both ways', async () => {
    const { backend, a, b } = await triggerReal409(CONV_ID);

    // Restore the real postCommit for everything that follows.
    const proto = Object.getPrototypeOf(backend);
    (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);

    // A real, genuinely independent initiator (B) invites A for real -- see
    // file header for exactly why the initiator-claim reset is needed and
    // what it represents.
    (backend as unknown as { initiatorClaims: Map<string, string> }).initiatorClaims.delete(CONV_ID);

    await b.mlsSvc.ensureGroupReady(CONV_ID, USER_A.did, USER_B, DEVICE_B);
    a.seedOwnKeyPackage();

    const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
    expect(joined).withContext('A genuinely joins via a real Welcome').toBe('joined');
    expect(a.getPendingGenesis(CONV_ID)).withContext('still no marker to collide with').toBeUndefined();

    const realStateAfterWelcomeB64 = a.getGroupStateB64(CONV_ID);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());

    // The REAL production entry point, exactly as a real send would call it.
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    // FIXED: with no marker to trigger a phantom rollback, ensureGroupReady()
    // is a clean no-op here -- the real, confirmed Welcome state is untouched.
    expect(a.getGroupStateB64(CONV_ID)).withContext('FIXED: no phantom rollback ever fires -- state unchanged').toBe(realStateAfterWelcomeB64);
    expect(a.memberDeviceIds(CONV_ID).sort()).toEqual([DEVICE_A.id, DEVICE_B.id].sort());

    // Real cryptographic proof both directions -- this is exactly the
    // communication that a silent fork would have broken before the fix.
    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres-correction-a-vers-b');
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('apres-correction-a-vers-b');
    const fromB = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'apres-correction-b-vers-a');
    expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromB)).toBe('apres-correction-b-vers-a');
  });

  it('3. répétition x20: le correctif est déterministe -- jamais de marker orphelin, jamais de régression, communication toujours fonctionnelle', async () => {
    for (let i = 0; i < 20; i++) {
      const convId = `conv-pendinggenesis-orphan-rep-${i}`;
      const { backend, a, b } = await triggerReal409(convId);

      expect(a.getPendingGenesis(convId)).withContext(`repetition ${i}: no orphaned marker`).toBeUndefined();

      const proto = Object.getPrototypeOf(backend);
      (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
      (backend as unknown as { initiatorClaims: Map<string, string> }).initiatorClaims.delete(convId);

      await b.mlsSvc.ensureGroupReady(convId, USER_A.did, USER_B, DEVICE_B);
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
