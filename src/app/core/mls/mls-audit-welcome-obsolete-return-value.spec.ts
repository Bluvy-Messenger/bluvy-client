import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import { MlsRepository } from './mls.repository';
import { ConversationMlsState } from './coordinator/mls-coordinator.types';
import type { WelcomeProcessingResult } from './mls.types';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// PERMANENT REGRESSION SUITE — P1 fix: "Welcome traité" != "join réussi".
//
// MlsWelcomeService.fetchAndProcessPendingWelcome() used to return a plain
// boolean that collapsed FOUR structurally different outcomes into two
// values -- `true` meant any of: a genuine join, a correctly-rejected
// obsolete Welcome (epoch guard), or an idempotent already-processed
// re-delivery (digest guard); `false` meant only "no pending Welcome at
// all". Callers that read `true` as "this device just joined / is now
// synchronized" were wrong for 2 of those 3 cases -- proven empirically
// (real ts-mls crypto) to let a device skip catchUpMissedCommits() inside
// ensureGroupReady(), and to let recoverFromFailed() declare a conversation
// Ready without ever reaching the catch-up fallback that would have
// genuinely repaired it.
//
// FIX: processWelcomeForConversation() and fetchAndProcessPendingWelcome()
// now return an explicit WelcomeProcessingResult ('joined' | 'obsolete' |
// 'already-processed' | 'none'). Only 'joined' is treated as a join by any
// caller. Production files changed: mls.types.ts (new type),
// mls-welcome.service.ts (the two methods' return values),
// mls.service.ts (ensureGroupReady()'s three call sites),
// coordinator/mls-coordinator.base.ts (abstract signature),
// coordinator/mls-coordinator.service.ts (the wrapper, recoverFromFailed(),
// and the decrypt heal path -- the latter mechanically adapted only, its
// behavior is unchanged since it never trusted the flag alone).
//
// Every test below exercises the REAL production code, real ts-mls crypto
// throughout (via testing/mls-multidevice-harness.ts). Casts to reach two
// private coordinator members (`states`, `recoverFromFailed`) are a pure
// white-box testing technique (no compiled-code change) needed only because
// recoverFromFailed()'s only production trigger is a 5s+ setTimeout backoff
// this suite does not want to sleep through.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-welcome-obsolete-return-value';

// Wraps a captured, real Welcome's bytes into the exact shape
// getPendingWelcomes() returns, for stubbing the network boundary only.
function welcomeResponse(items: Array<{ id: string; welcome: string }>): { data: Array<{ id: string; conversationId: string | null; welcome: string; createdAt: number }> } {
  return { data: items.map(it => ({ id: it.id, conversationId: CONV_ID, welcome: it.welcome, createdAt: Date.now() })) };
}

// Builds the real-crypto precondition shared by most tests below: A and B
// confirmed at epoch 1 (makeGroup), then B genuinely reprovisions A TWICE in
// a row (each a real Remove(old leaf)+Add(fresh leaf) commit) -- producing
// two structurally DIFFERENT, both genuinely real, Welcomes for A: Welcome#1
// (epoch 2) and Welcome#2 (epoch 3). This mirrors the exact "genuinely NEW
// Welcome can arrive under an id already seen" scenario the digest-guard's
// own doc comment in mls-welcome.service.ts documents as reachable (a fresh
// reprovision landing while an earlier one is still an untouched, valid,
// pending row).
//
// A joins for real via ONLY Welcome#2 (the network boundary is stubbed for
// this one call to return just the newer item, exactly like a real client
// that only ever observed the latest server row) -- so A ends up genuinely
// confirmed at epoch 3, and Welcome#1's bytes are captured but NEVER
// consumed, digested, or acked by A. This is what lets a later redelivery
// of Welcome#1 genuinely exercise the epoch-guard's "obsolete, first time
// seen" branch, not the (structurally different) digest-guard branch.
async function buildStaleWelcomeScenario(backend: FakeMlsBackend, a: Device, b: Device): Promise<{ staleWelcomeB64: string; repoA: MlsRepository }> {
  await makeGroup(CONV_ID, backend, a, [b]);
  expect(a.epoch(CONV_ID)).toBe(1);

  await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 1 -> 2
  a.seedOwnKeyPackage(); // capture KP#1 before the second reprovision overwrites the cache slot
  const afterFirst = await backend.getPendingWelcomes(DEVICE_A.id, CONV_ID);
  expect(afterFirst.data.length).toBe(1);
  const staleWelcomeB64 = afterFirst.data[0]!.welcome; // Welcome#1, epoch 2 -- never consumed below

  await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 2 -> 3
  a.seedOwnKeyPackage(); // capture KP#2
  const afterSecond = await backend.getPendingWelcomes(DEVICE_A.id, CONV_ID);
  expect(afterSecond.data.length).toBe(2);
  const freshWelcomeB64 = afterSecond.data[1]!.welcome; // Welcome#2, epoch 3

  const repoA = a.injector.get(MlsRepository);
  const spy = spyOn(repoA, 'getPendingWelcomes').and.resolveTo(welcomeResponse([{ id: 'fresh-only', welcome: freshWelcomeB64 }]));
  const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
  expect(joined).withContext('A genuinely joins via Welcome#2 only').toBe('joined');
  expect(a.epoch(CONV_ID)).withContext('A is now genuinely confirmed at the latest real epoch').toBe(3);
  spy.and.stub(); // detach; each caller re-programs it for its own next call

  return { staleWelcomeB64, repoA };
}

describe('P1 FIX -- fetchAndProcessPendingWelcome() no longer conflates "obsolete rejected" with "joined"', () => {

  it('1. CASE A/D (baseline): a genuinely applied Welcome -- GroupState changes, epoch changes, ACK sent, result === \'joined\'', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B);
    a.seedOwnKeyPackage();

    const repoA = a.injector.get(MlsRepository);
    const ackSpy = spyOn(repoA, 'ackWelcome').and.callThrough();

    const stateBefore = a.getGroupStateB64(CONV_ID);
    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);

    expect(result).withContext('genuine join must report \'joined\'').toBe('joined');
    expect(a.epoch(CONV_ID)).withContext('epoch actually advanced 1 -> 2').toBe(2);
    expect(a.getGroupStateB64(CONV_ID)).withContext('GroupState actually changed').not.toBe(stateBefore);
    expect(ackSpy).withContext('a genuine join DOES ack the consumed Welcome').toHaveBeenCalled();
  });

  it('2. CASE B (ANCIEN TEST ROUGE, maintenant VERT): an obsolete Welcome, never seen before, is correctly rejected -- result === \'obsolete\', GroupState byte-identical, no ACK, no join', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    const stateBeforeStaleDelivery = a.getGroupStateB64(CONV_ID);

    // Simulate Welcome#1 (real bytes, epoch 2, never before seen by A) being
    // served by the server -- e.g. a delayed re-fetch of a row A never
    // polled while it was current. Only the network boundary
    // (getPendingWelcomes) is stubbed; everything else (decodeMlsMessage,
    // joinGroup(), the epoch guard, the digest guard) is the real,
    // unmodified production code.
    const ackSpy = spyOn(repoA, 'ackWelcome').and.callThrough();
    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-1', welcome: staleWelcomeB64 }]));

    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);

    expect(result)
      .withContext('FIXED: fetchAndProcessPendingWelcome() now explicitly reports \'obsolete\', never \'joined\', for a correctly-rejected stale Welcome')
      .toBe('obsolete');
    expect(a.epoch(CONV_ID)).withContext('epoch must NOT have regressed').toBe(3);
    expect(a.getGroupStateB64(CONV_ID)).withContext('GroupState byte-identical -- the rejection itself is correct').toBe(stateBeforeStaleDelivery);
    expect(ackSpy).withContext('the FIRST-time obsolete rejection deliberately does NOT ack (mls-welcome.service.ts)').not.toHaveBeenCalled();
  });

  it('3. CASE C: the SAME obsolete Welcome redelivered AGAIN hits the digest guard instead -- result === \'already-processed\', DOES ack every time (distinguishes the two non-join \'processed\' paths); idempotent, no drift across repetitions', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    const ackSpy = spyOn(repoA, 'ackWelcome').and.callThrough();
    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-repeat', welcome: staleWelcomeB64 }]));

    const stateBefore = a.getGroupStateB64(CONV_ID);
    const results: WelcomeProcessingResult[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A));
      expect(a.epoch(CONV_ID)).withContext(`repetition ${i}: no drift`).toBe(3);
      expect(a.getGroupStateB64(CONV_ID)).withContext(`repetition ${i}: byte-identical`).toBe(stateBefore);
    }
    // Repetition 0 hits the epoch-guard "obsolete, first time seen" branch
    // (records the digest, does not ack). Repetitions 1 and 2 of the
    // identical bytes hit the EARLIER digest guard instead -- 'already-processed',
    // which DOES ack every time. Neither is ever 'joined'.
    expect(results).withContext('none of the three repetitions is ever a join').toEqual(['obsolete', 'already-processed', 'already-processed']);
    expect(ackSpy.calls.count()).withContext('digest-guard redeliveries (repetitions 1 and 2) each ack').toBe(2);
  });

  it('4. Aucun Welcome disponible: fetchAndProcessPendingWelcome() reports \'none\', not \'obsolete\' or a falsy join', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);

    expect(result).toBe('none');
    expect(a.epoch(CONV_ID)).withContext('no state change').toBe(1);
  });

  it('5. ensureGroupReady() + obsolete Welcome: the real production coordinator path NOW correctly runs catchUpMissedCommits() -- A converges to the current epoch instead of staying stuck', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    // A real, currently-uncaught-up commit exists on the server (epoch 3->4).
    await b.membershipSvc.provisionDevice('device-b-3', CONV_ID, USER_B, DEVICE_B);
    expect(a.epoch(CONV_ID)).withContext('A has NOT caught up to this one yet').toBe(3);

    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-egr', welcome: staleWelcomeB64 }]));

    // The REAL production entry point: coordinator.ensureGroupReady(), the
    // exact call every real send goes through (conversation.page.ts).
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(a.coordinator.isConversationReady(CONV_ID)).toBe(true);
    expect(a.epoch(CONV_ID))
      .withContext('FIXED: the obsolete Welcome no longer masks the missed commit -- catchUpMissedCommits() ran, A converges to 4')
      .toBe(4);
  });

  it('6. ensureGroupReady() + obsolete Welcome + PLUSIEURS commits manqués: convergence complète jusqu\'au dernier epoch', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    // THREE real, currently-uncaught-up commits (epoch 3 -> 4 -> 5 -> 6).
    await b.membershipSvc.provisionDevice('device-b-3', CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('device-b-4', CONV_ID, USER_B, DEVICE_B);
    await b.membershipSvc.provisionDevice('device-b-5', CONV_ID, USER_B, DEVICE_B);
    expect(a.epoch(CONV_ID)).withContext('A has not caught up to any of these').toBe(3);
    expect(backend.getCommits(CONV_ID).filter(c => c.epoch >= 3).length).toBe(3);

    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-multi', welcome: staleWelcomeB64 }]));

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    expect(a.epoch(CONV_ID)).withContext('converges past all three missed commits in one call').toBe(6);
    expect(a.memberDeviceIds(CONV_ID)).toEqual(jasmine.arrayContaining(['device-b-3', 'device-b-4', 'device-b-5']));
  });

  it('7. recoverFromFailed() + obsolete Welcome: no longer declares Ready via the shortcut -- falls through to the catch-up fallback, which genuinely repairs the conversation', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    // A real, catchable missed commit exists (epoch 3 -> 4).
    await b.membershipSvc.provisionDevice('device-b-3', CONV_ID, USER_B, DEVICE_B);
    expect(a.epoch(CONV_ID)).toBe(3);

    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-recover', welcome: staleWelcomeB64 }]));

    // White-box only: force FAILED (recoverFromFailed()'s only production
    // trigger is a 5s+ setTimeout backoff) and invoke the private recovery
    // method directly -- no production code is modified by this cast.
    const coordInternal = a.coordinator as unknown as {
      states: Map<string, ConversationMlsState>;
      recoverFromFailed(convId: string, user: UserProfile, device: DeviceInfo): Promise<void>;
    };
    coordInternal.states.set(CONV_ID, ConversationMlsState.Failed);

    await coordInternal.recoverFromFailed(CONV_ID, USER_A, DEVICE_A);

    expect(a.coordinator.isConversationReady(CONV_ID)).withContext('Ready -- but now because it was GENUINELY repaired').toBe(true);
    expect(a.coordinator.isConversationFailed(CONV_ID)).toBe(false);
    expect(a.epoch(CONV_ID))
      .withContext('FIXED: the catch-up fallback was actually reached and applied the real missed commit, inside this single recoverFromFailed() call')
      .toBe(4);
  });

  it('8. Preuve cryptographique du scénario original, APRÈS correction: A converges to the server epoch, encrypts, and C (who joined during the gap) decrypts SUCCESS', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const DEVICE_C: DeviceInfo = { id: 'device-b-newest', name: 'Tablet', platform: 'android' };
    const c = new Device(backend, USER_B, DEVICE_C); // B's second device, joins at the newer epoch

    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);

    // C joins the group fresh at epoch 4 -- ONLY has epoch-4 secrets.
    await b.membershipSvc.provisionDevice(DEVICE_C.id, CONV_ID, USER_B, DEVICE_B);
    await c.joinViaPendingWelcome(CONV_ID);
    expect(c.epoch(CONV_ID)).toBe(4);
    // AVANT (documented by tests 5/6 above): A would have stayed at epoch 3.

    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-crypto', welcome: staleWelcomeB64 }]));

    // Real production pattern: ensureGroupReady() then encryptMessage().
    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);
    expect(a.epoch(CONV_ID)).withContext('APRÈS: A converged to the current epoch').toBe(4);

    const ciphertext = await a.coordinator.encryptMessage(CONV_ID, 'message after real fix', USER_A, DEVICE_A);
    const plaintext = await c.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_C, ciphertext);

    expect(plaintext).withContext('APRÈS: real cryptographic SUCCESS -- the original scenario is genuinely fixed').toBe('message after real fix');
  });

  it('9. Welcome hors ordre, un seul lot: le plus récent puis le plus ancien dans la MÊME réponse -- convergence vers l\'epoch le plus récent, l\'ancien correctement rejeté sans re-régression', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 1->2
    a.seedOwnKeyPackage();
    const older = (await backend.getPendingWelcomes(DEVICE_A.id, CONV_ID)).data[0]!.welcome;
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 2->3
    a.seedOwnKeyPackage();
    const newer = (await backend.getPendingWelcomes(DEVICE_A.id, CONV_ID)).data[1]!.welcome;

    const repoA = a.injector.get(MlsRepository);
    // Reversed order: newer item first, older item second, in ONE fetch response.
    spyOn(repoA, 'getPendingWelcomes').and.resolveTo(welcomeResponse([
      { id: 'w-newer', welcome: newer },
      { id: 'w-older', welcome: older },
    ]));

    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);

    // The newer Welcome applies first (real join, epoch 1 -> 3); the older
    // one, examined second in the SAME loop, is now obsolete relative to
    // A's just-updated state and is correctly rejected -- 'joined' still
    // wins as the aggregate result (highest priority), and the epoch does
    // NOT regress back to 2.
    expect(result).withContext('\'joined\' wins over \'obsolete\' in the same batch').toBe('joined');
    expect(a.epoch(CONV_ID)).withContext('converges to the newest real epoch, no regression from the older item processed after').toBe(3);

    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'out-of-order-batch');
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('out-of-order-batch');
  });

  it('10. non-regression: a genuinely NEWER real Welcome arriving after an older one (natural order) is still correctly accepted -- the epoch-guard\'s correct behavior is untouched by this fix', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    await makeGroup(CONV_ID, backend, a, [b]);

    // Two real, successive reprovisions of A -- each produces a genuinely
    // newer Welcome. The fake backend (unlike the real one) does not
    // upsert/overwrite the pending row, so both land in the queue; A
    // processes both in one fetchAndProcessPendingWelcome() call, oldest
    // first -- neither is obsolete relative to A's state AT THE TIME each is
    // examined, so both apply for real, epoch converges to the latest.
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 1->2
    a.seedOwnKeyPackage(); // capture KP#1 before the second reprovision overwrites the cache slot
    await b.membershipSvc.reprovisionLostStateDevice(DEVICE_A.id, CONV_ID, USER_B, DEVICE_B); // epoch 2->3
    a.seedOwnKeyPackage(); // capture KP#2
    const pending = await backend.getPendingWelcomes(DEVICE_A.id, CONV_ID);
    expect(pending.data.length).toBe(2);

    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
    expect(result).toBe('joined');
    expect(a.epoch(CONV_ID)).withContext('converges to the latest, real epoch -- normal behavior, unaffected').toBe(3);
    expect(a.memberDeviceIds(CONV_ID)).toContain(DEVICE_A.id);

    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'post-reprovision');
    // B independently applies both real commits via the normal commit path.
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('post-reprovision');
  });

  it('11. existing protections intact: epoch never regresses and no digest/state corruption occurs anywhere in this suite\'s scenarios', async () => {
    const backend = new FakeMlsBackend();
    const a = new Device(backend, USER_A, DEVICE_A);
    const b = new Device(backend, USER_B, DEVICE_B);
    const { staleWelcomeB64, repoA } = await buildStaleWelcomeScenario(backend, a, b);
    const epochBeforeAttack = a.epoch(CONV_ID);
    expect(epochBeforeAttack).toBe(3);

    (repoA.getPendingWelcomes as jasmine.Spy).and.resolveTo(welcomeResponse([{ id: 'stale-redelivery-final', welcome: staleWelcomeB64 }]));

    const result = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
    expect(result).toBe('obsolete');

    // The GroupState epoch guard (mls-welcome.service.ts) is the actual
    // safety invariant here -- it is what's being proven intact.
    expect(a.epoch(CONV_ID)).withContext('epoch NEVER regresses').toBe(epochBeforeAttack);

    // Real traffic at the current epoch still works normally afterwards.
    const fromA = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'still fine');
    await b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B);
    expect(await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, fromA)).toBe('still fine');
  });
});
