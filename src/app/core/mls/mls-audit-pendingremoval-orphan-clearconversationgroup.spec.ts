import { HttpErrorResponse } from '@angular/common/http';
import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { PendingRemovalRecord } from './mls.types';

// PERMANENT REGRESSION SUITE — P1 fix: pendingRemovals orphaned marker
// after clearConversationGroup() (409) AND after the independent 403/404
// orphaning path in removeRevokedDeviceFromAllGroups() -- the removal
// sibling of the genesis defect fixed in
// mls-audit-pendinggenesis-orphan-clearconversationgroup.investigation.spec.ts.
//
// Structural risk audit (this session) confirmed removeRevokedDeviceFromAllGroups()'s
// 409 handler is byte-for-byte identical in shape to genesis's and
// reprovision's: it writes pendingRemovals[conversationId] in the SAME
// optimistic storage.update() that later 409s, and clearConversationGroup()
// used to delete groupStates[conversationId] without ever touching that
// marker. A SECOND, independent orphaning path was found in this same
// method's 403/404 branch (acquireCommitLock failure), which deletes
// groupStates[convId] inline -- NOT via clearConversationGroup() -- with
// the identical gap, fixed separately in the same storage.update() callback.
//
// Real ts-mls crypto throughout, via testing/mls-multidevice-harness.ts.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const DEVICE_C: DeviceInfo = { id: 'device-c1', name: 'Tablet', platform: 'ios' };
const CONV_ID = 'conv-pendingremoval-orphan';

// A+B+C real group, then A's own removal attempt (revoking C) forced to a
// real 409.
async function triggerReal409(convId: string): Promise<{ backend: FakeMlsBackend; a: Device; b: Device; c: Device }> {
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  const c = new Device(backend, { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null }, DEVICE_C);
  await makeGroup(convId, backend, a, [b, c]);
  expect(a.epoch(convId)).toBe(1);

  backend.postCommit = (async () => {
    throw new HttpErrorResponse({ status: 409, error: { error: { code: 'EPOCH_GAP' } } });
  }) as typeof backend.postCommit;

  // removeRevokedDeviceFromAllGroups() catches the 409 per-conversation and
  // continues its internal loop -- it never rejects the outer call.
  await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_C.id, USER_A, DEVICE_A);

  return { backend, a, b, c };
}

describe('P1 FIX -- pendingRemovals no longer orphaned after clearConversationGroup() (409) or the 403/404 branch', () => {

  it('1. FIXED: a real removal 409 no longer leaves an orphaned pendingRemovals marker', async () => {
    const { a } = await triggerReal409(CONV_ID);

    expect(a.getGroupStateB64(CONV_ID)).withContext('groupState absent after the 409').toBeUndefined();
    expect(a.getPendingRemoval(CONV_ID)).withContext('FIXED: the marker no longer survives the 409').toBeUndefined();
  });

  it('2. FIXED end-to-end: 409 -> no orphaned marker -> a real, independent reprovision-of-A converges cleanly, no phantom rollback, real crypto works both ways', async () => {
    const { backend, a, b } = await triggerReal409(CONV_ID);

    const proto = Object.getPrototypeOf(backend);
    (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
    // Test-only: A's forced 409 short-circuited past postCommit()'s own
    // lock-release-on-success line, leaving the fake backend's server-side
    // commit lock stuck held by A -- release it directly (private field,
    // cast from the test, no harness FILE edit) so B's genuinely independent
    // recovery below isn't artificially blocked by A's failed attempt.
    (backend as unknown as { locks: Map<string, string> }).locks.delete(CONV_ID);

    // B, genuinely unaffected by A's failed removal attempt, independently
    // notices A "lost its state" and reprovisions it for real -- lands A
    // back at exactly the epoch A's own failed attempt's marker remembers
    // as newEpoch (both are A's epoch-1 state's next real commit).
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B);
    a.seedOwnKeyPackage();

    const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
    expect(joined).withContext('A genuinely rejoins via a real Welcome').toBe('joined');
    expect(a.epoch(CONV_ID)).toBe(2);
    expect(a.getPendingRemoval(CONV_ID)).withContext('still no marker to collide with').toBeUndefined();

    const realStateAfterWelcomeB64 = a.getGroupStateB64(CONV_ID);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(a.getGroupStateB64(CONV_ID)).withContext('FIXED: no phantom rollback ever fires -- state unchanged').toBe(realStateAfterWelcomeB64);

    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres-correction-removal-a-vers-b');
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('apres-correction-removal-a-vers-b');
    const fromB = await b.messageCryptoSvc.encryptMessage(CONV_ID, USER_B, DEVICE_B, 'apres-correction-removal-b-vers-a');
    expect(await a.messageCryptoSvc.decryptMessage(CONV_ID, USER_A, DEVICE_A, fromB)).toBe('apres-correction-removal-b-vers-a');
  });

  it('3. FIXED: the independent 403/404 branch (acquireCommitLock failure) also no longer leaves a stale pending marker behind', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    // Seed a stale marker directly, representing a leftover from an earlier
    // crashed/unrelated attempt for this same conversationId -- exactly the
    // class of orphan this fix targets, not a live one (this branch never
    // writes its own marker before reaching acquireCommitLock).
    const staleMarker: PendingRemovalRecord = {
      revokedDeviceId:  'device-stale',
      previousEpoch:    0,
      previousStateB64: a.getGroupStateB64(CONV_ID)!,
      newEpoch:         1,
    };
    a.seedPendingRemoval(CONV_ID, staleMarker);
    expect(a.getPendingRemoval(CONV_ID)).toBeDefined();

    backend.acquireCommitLock = (async () => {
      throw new HttpErrorResponse({ status: 403, error: { error: { code: 'FORBIDDEN' } } });
    }) as typeof backend.acquireCommitLock;

    await a.membershipSvc.removeRevokedDeviceFromAllGroups(DEVICE_B.id, USER_A, DEVICE_A);

    expect(a.getGroupStateB64(CONV_ID)).withContext('403/404 branch clears groupState as before').toBeUndefined();
    expect(a.getPendingRemoval(CONV_ID)).withContext('FIXED: the 403/404 branch now also cleans up the marker').toBeUndefined();
  });

  it('4. répétition x20: le correctif est déterministe pour la suppression -- jamais de marker orphelin, jamais de régression', async () => {
    for (let i = 0; i < 20; i++) {
      const convId = `conv-pendingremoval-orphan-rep-${i}`;
      const { backend, a, b } = await triggerReal409(convId);

      expect(a.getPendingRemoval(convId)).withContext(`repetition ${i}: no orphaned marker`).toBeUndefined();

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
