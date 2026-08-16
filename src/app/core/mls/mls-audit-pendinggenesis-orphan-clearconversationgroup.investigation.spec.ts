import { HttpErrorResponse } from '@angular/common/http';
import { FakeMlsBackend, Device } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// READ-ONLY REPRODUCTION — P1 finding from the "AUDIT FINAL CIBLÉ" pass:
// clearConversationGroup() (mls-membership.service.ts) removes
// groupStates[conversationId] on a genesis 409 (mls.service.ts:473-478) but
// never touches pendingGenesises[conversationId] -- the marker survives as
// an orphan. This file determines, with real ts-mls crypto throughout via
// testing/mls-multidevice-harness.ts, whether a subsequent REAL Welcome
// landing at exactly marker.newEpoch can make recoverOnePendingGenesis()
// (mls.service.ts:621-694) wrongly treat the real, confirmed multi-member
// GroupState as its own phantom write and roll it back to
// marker.previousStateB64 (the stale pre-genesis solo state).
//
// NO PRODUCTION CODE IS MODIFIED. clearConversationGroup(),
// recoverOnePendingGenesis(), and every marker are used exactly as they
// exist today.
//
// Test-only harness interactions, both documented precisely here and
// nowhere touching production or the harness file itself:
//
// 1. `backend.postCommit = (async () => { throw new HttpErrorResponse({
//    status: 409, error: { error: { code: 'EPOCH_GAP' } } }); })` -- the
//    EXACT interception pattern already established in this codebase's own
//    test suite (mls-invariants-ensuregroupready-crashrestart.spec.ts,
//    test "J. 409"), representing what Angular's HttpClient genuinely
//    produces for a non-2xx backend response (mls.repository.ts's
//    postCommit() does not catch/translate anything itself -- whatever
//    ApiClientService/HttpClient throws propagates verbatim, so a real
//    backend EPOCH_GAP (statusCode 409, confirmed in
//    bluvy-backend/src/modules/mls/mls.service.test.ts) genuinely surfaces
//    as HttpErrorResponse with status 409 in production). This is not an
//    invented error shape.
//
// 2. `(backend as unknown as { initiatorClaims: Map<string,string> })
//    .initiatorClaims.delete(CONV_ID)` -- a direct manipulation of the fake
//    backend's OWN simplified initiator-claim map (private field, accessed
//    via cast from the test, no harness FILE edit). This is necessary
//    because FakeMlsBackend.ensureGroup()'s own doc comment explicitly
//    admits it is "NOT a full reimplementation of every
//    claimInitiatorSlot() branch (the device_never_welcomed/lost_state
//    nudge branches are backend-internal logic ... not re-tested here)" --
//    i.e. the fake backend deliberately does not model the real backend's
//    mechanism for releasing a stuck initiator claim after a failed
//    attempt. Without this, NO second device could ever become a real
//    initiator for the same conversationId after device A's failed
//    attempt, making it impossible to reach the "real Welcome" step
//    through any path at all -- not because the bug is unreachable, but
//    because the fake backend's initiator-claim simplification would
//    artificially block it. Documented precisely; does not touch
//    cryptography, storage, or any MLS invariant -- purely a backend-role
//    bookkeeping reset.
//
// IMPORTANT FINDING ABOUT THE ORIGINAL AUDIT HYPOTHESIS'S "real conflict"
// framing, established by reading the fake backend's postCommit() (which
// mirrors the real backend's storeMlsCommit() contract per its own doc
// comment): a genuine two-device RACE for the exact same epoch does NOT
// throw an error at all -- postCommit()'s dedup branch
// (`existing = rows.find(r => r.epoch === epoch); if (existing) return
// existing;`) SILENTLY returns the winning row to the loser. A real 409
// EPOCH_GAP can only occur when the poster's epoch is strictly behind the
// server's current epoch by more than the dedup case (i.e. a real gap, not
// a same-epoch collision) -- e.g. a genuinely delayed network request
// landing after the server has already advanced further. This is why the
// scenario below is constructed deterministically (not via actual Promise
// racing) yet remains causally realistic: A's Phase 2 request is treated as
// the one that arrives late/rejected, exactly the "device_never_welcomed"
// class of real-world event the backend is documented to handle.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-pendinggenesis-orphan';

// Steps 1-5 of the reproduction: real genesis 409 -> orphaned marker ->
// real Welcome from a genuinely independent initiator (B), landing A at
// exactly marker.newEpoch. Returns everything needed to assert on the
// precondition and to run the real ensureGroupReady() step separately.
async function buildOrphanedMarkerThenRealWelcome(): Promise<{
  backend: FakeMlsBackend;
  a: Device;
  b: Device;
  markerBeforeRecovery: { previousEpoch: number; previousStateB64: string; newEpoch: number };
  realStateAfterWelcomeB64: string;
}> {
  const backend = new FakeMlsBackend();
  const a = new Device(backend, USER_A, DEVICE_A);
  const b = new Device(backend, USER_B, DEVICE_B);
  backend.registerParticipant(USER_B.did, DEVICE_B.id);
  backend.registerParticipant(USER_A.did, DEVICE_A.id);
  await a.mlsSvc.initializeForSession(USER_A, DEVICE_A);
  await b.mlsSvc.initializeForSession(USER_B, DEVICE_B);

  // ── Étape 1+2: A real Genesis Phase 2 attempt, forced to a real 409 ────
  backend.postCommit = (async () => {
    throw new HttpErrorResponse({ status: 409, error: { error: { code: 'EPOCH_GAP' } } });
  }) as typeof backend.postCommit;

  await expectAsync(a.mlsSvc.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A)).toBeRejected();

  // ── Étape 3: vérifier l'état après clearConversationGroup() ────────────
  expect(a.getGroupStateB64(CONV_ID)).withContext('groupState absent après le 409 (clearConversationGroup a bien tourné)').toBeUndefined();
  const markerBeforeRecovery = a.getPendingGenesis(CONV_ID);
  expect(markerBeforeRecovery).withContext('QUESTION 1: le marker pendingGenesises survit-il au 409 ?').toBeDefined();

  // Restore the real postCommit for everything that follows.
  const proto = Object.getPrototypeOf(backend);
  (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);

  // ── Étape 4: VRAI Welcome, d'un initiateur RÉELLEMENT indépendant (B) ──
  // Test-only reset of the fake backend's simplified initiator-claim map --
  // see file header for exactly why and what this represents.
  (backend as unknown as { initiatorClaims: Map<string, string> }).initiatorClaims.delete(CONV_ID);

  await b.mlsSvc.ensureGroupReady(CONV_ID, USER_A.did, USER_B, DEVICE_B);
  // B's real Phase 2 Add(A) just consumed a freshly-generated real KeyPackage
  // for A's deviceId -- seed it into A's own local storage so A's real
  // fetchAndProcessPendingWelcome() below can actually match and joinGroup().
  a.seedOwnKeyPackage();

  const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(CONV_ID, USER_A, DEVICE_A);
  expect(joined).withContext('A rejoint réellement via un vrai Welcome (vrai joinGroup(), vraie KeyPackage)').toBe('joined');

  const realStateAfterWelcomeB64 = a.getGroupStateB64(CONV_ID)!;
  expect(realStateAfterWelcomeB64).withContext('un vrai GroupState existe après le vrai Welcome').toBeDefined();
  expect(realStateAfterWelcomeB64).not.toBe(markerBeforeRecovery!.previousStateB64);
  expect(a.memberDeviceIds(CONV_ID).sort()).withContext('membership réel multi-membre').toEqual([DEVICE_A.id, DEVICE_B.id].sort());

  return { backend, a, b, markerBeforeRecovery: markerBeforeRecovery!, realStateAfterWelcomeB64 };
}

describe('P1 REPRODUCTION -- pendingGenesises orphan after clearConversationGroup() (409)', () => {

  it('TEST 1: Genesis 409 -> marker orphelin -> vrai Welcome -> ensureGroupReady() -> vérifier si le GroupState confirmé régresse', async () => {
    const { a, b, markerBeforeRecovery, realStateAfterWelcomeB64 } = await buildOrphanedMarkerThenRealWelcome();

    // ── Étape 5: condition critique ─────────────────────────────────────
    const realEpoch = a.epoch(CONV_ID);
    console.log('[REPRO] marker.newEpoch =', markerBeforeRecovery.newEpoch, ' real epoch after Welcome =', realEpoch);
    const epochCollision = realEpoch === markerBeforeRecovery.newEpoch;

    if (!epochCollision) {
      console.log('[REPRO] QUESTION 3: currentEpoch === marker.newEpoch NE se produit PAS dans cette construction -- hypothèse d\'origine invalidée pour ce chemin précis.');
    }
    expect(epochCollision).withContext('QUESTION 3: currentEpoch === marker.newEpoch doit se produire pour que la précondition du finding soit réunie').toBe(true);
    expect(a.getPendingGenesis(CONV_ID)).withContext('QUESTION 2: le marker existe toujours juste avant ensureGroupReady() (le vrai Welcome ne l\'a jamais nettoyé)').toBeDefined();

    // ── Étape 6: le VRAI point d'entrée production ──────────────────────
    const beforeEpoch    = a.epoch(CONV_ID);
    const beforeMembers  = a.memberDeviceIds(CONV_ID).sort();
    const beforeStateB64 = a.getGroupStateB64(CONV_ID);

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    const afterEpoch    = a.epoch(CONV_ID);
    const afterMembers  = a.memberDeviceIds(CONV_ID).sort();
    const afterStateB64 = a.getGroupStateB64(CONV_ID);

    console.log('[REPRO] AVANT ensureGroupReady(): epoch=', beforeEpoch, 'members=', beforeMembers, 'state===previousStateB64?', beforeStateB64 === markerBeforeRecovery.previousStateB64);
    console.log('[REPRO] APRÈS ensureGroupReady(): epoch=', afterEpoch, 'members=', afterMembers, 'state===previousStateB64?', afterStateB64 === markerBeforeRecovery.previousStateB64);

    // ── Étape 7: preuve de régression (comparaison stricte avec previousStateB64, pas seulement les membres) ──
    const regressed = afterStateB64 === markerBeforeRecovery.previousStateB64;

    if (regressed) {
      console.log('[REPRO] VERDICT: RÉGRESSION CONFIRMÉE -- le GroupState réel a été remplacé par previousStateB64 (état solo pré-genesis).');
    } else {
      console.log('[REPRO] VERDICT: PAS de régression observée -- afterStateB64 !== previousStateB64.');
    }

    // These assertions record the ACTUAL observed outcome (not an assumption)
    // for this specific single-repetition run; TEST 2 repeats 20x to rule
    // out flakiness before the final report draws a conclusion.
    expect(afterStateB64).withContext('COMPARAISON avec marker.previousStateB64').toEqual(jasmine.any(String));
    void realStateAfterWelcomeB64; void b; void beforeMembers; void afterMembers;
  });

  it('TEST 2: répétition x20 pour écarter une race flaky (le scénario est construit de façon déterministe, pas par un vrai race de Promises)', async () => {
    let regressedCount = 0;
    let noMarkerCount = 0;
    let noEpochCollisionCount = 0;

    for (let i = 0; i < 20; i++) {
      const convId = `conv-pendinggenesis-orphan-rep-${i}`;
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

      const marker = a.getPendingGenesis(convId);
      if (!marker) { noMarkerCount++; continue; }

      const proto = Object.getPrototypeOf(backend);
      (backend as unknown as { postCommit: unknown }).postCommit = proto.postCommit.bind(backend);
      (backend as unknown as { initiatorClaims: Map<string, string> }).initiatorClaims.delete(convId);

      await b.mlsSvc.ensureGroupReady(convId, USER_A.did, USER_B, DEVICE_B);
      a.seedOwnKeyPackage();
      const joined = await a.mlsSvc.fetchAndProcessPendingWelcome(convId, USER_A, DEVICE_A);
      expect(joined).toBe('joined');

      if (a.epoch(convId) !== marker.newEpoch) { noEpochCollisionCount++; continue; }

      await a.coordinator.ensureGroupReady(convId, USER_B.did, USER_A, DEVICE_A);
      const finalStateB64 = a.getGroupStateB64(convId);
      if (finalStateB64 === marker.previousStateB64) regressedCount++;
    }

    console.log(`[REPRO x20] regressed=${regressedCount} noMarker=${noMarkerCount} noEpochCollision=${noEpochCollisionCount} out of 20`);
    expect(noMarkerCount).withContext('déterminisme: le marker orphelin doit apparaître à chaque répétition').toBe(0);
    expect(noEpochCollisionCount).withContext('déterminisme: la collision d\'epoch doit se produire à chaque répétition').toBe(0);
    // No assertion on regressedCount here -- the count itself IS the finding,
    // reported verbatim rather than asserted against an assumed value.
  });

  it('TEST 3: preuve cryptographique -- si régression confirmée, A perd-il réellement la capacité de communiquer avec B après la mauvaise recovery ?', async () => {
    const { a, b, markerBeforeRecovery } = await buildOrphanedMarkerThenRealWelcome();

    // AVANT la recovery: A (état réel post-Welcome) peut chiffrer, B peut déchiffrer.
    const beforeMsg = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'avant-recovery');
    const beforeDecrypted = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, beforeMsg);
    expect(beforeDecrypted).withContext('AVANT: communication réelle A<->B fonctionne').toBe('avant-recovery');

    await a.coordinator.ensureGroupReady(CONV_ID, USER_B.did, USER_A, DEVICE_A);

    const stateAfter = a.getGroupStateB64(CONV_ID);
    const didRegress = stateAfter === markerBeforeRecovery.previousStateB64;
    console.log('[REPRO CRYPTO] didRegress =', didRegress);

    if (!didRegress) {
      console.log('[REPRO CRYPTO] Pas de régression observée dans cette exécution -- preuve cryptographique non applicable, communication devrait rester fonctionnelle.');
      const stillMsg = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres-pas-de-regression');
      const stillDecrypted = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, stillMsg);
      expect(stillDecrypted).toBe('apres-pas-de-regression');
      return;
    }

    // APRÈS une régression confirmée: A tente de chiffrer avec l'état solo régressé.
    let cryptoBroken = false;
    let afterMsg: string | undefined;
    try {
      afterMsg = await a.messageCryptoSvc.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'apres-mauvaise-recovery');
    } catch (err) {
      cryptoBroken = true;
      console.log('[REPRO CRYPTO] encryptMessage() a échoué directement sur l\'état régressé:', err);
    }

    if (!cryptoBroken && afterMsg) {
      try {
        const decrypted = await b.messageCryptoSvc.decryptMessage(CONV_ID, USER_B, DEVICE_B, afterMsg);
        console.log('[REPRO CRYPTO] B a réussi à déchiffrer malgré la régression (inattendu):', decrypted);
      } catch (err) {
        cryptoBroken = true;
        console.log('[REPRO CRYPTO] APRÈS: B ne peut plus déchiffrer le message d\'A (état régressé, epoch/arbre différents):', err);
      }
    }

    console.log('[REPRO CRYPTO] VERDICT impact cryptographique réel:', cryptoBroken ? 'CONFIRMÉ (communication cassée après la mauvaise recovery)' : 'NON CONFIRMÉ dans cette exécution');
    expect(cryptoBroken).withContext('preuve cryptographique de la conséquence réelle de la régression').toBe(true);
  });
});
