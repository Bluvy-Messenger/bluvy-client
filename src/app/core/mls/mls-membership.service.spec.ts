import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import {
  createGroup,
  createCommit,
  generateKeyPackage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  defaultCryptoProvider,
  defaultCapabilities,
  defaultLifetime,
  defaultAuthenticationService,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  encodeGroupState,
  decodeGroupState,
  encodeMlsMessage,
  decodeMlsMessage,
  type ClientConfig,
  type ClientState,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { MlsMembershipService } from './mls-membership.service';
import { MlsCommitService } from './mls-commit.service';
import { MlsRepository } from './mls.repository';
import { MlsStateStorageService } from './mls-state-storage.service';
import { MlsPendingCommitTracker } from './mls-pending-commit-tracker.service';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { StoredMlsState } from './mls.types';

// ── Real-MLS test fixtures ─────────────────────────────────────────────────
// The commit-lock behavior under test here (provisionDevice /
// removeRevokedDeviceFromAllGroups) sits around real ts-mls crypto calls
// (createCommit, decodeGroupState, ...) made directly in
// mls-membership.service.ts, not behind an injectable seam. So instead of
// mocking crypto, these tests build small real MLS groups with ts-mls itself
// (same functions, same options, as production code) and only mock the two
// injected collaborators: MlsRepository (network) and MlsStateStorageService
// (IndexedDB).

const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

async function getCs() {
  return getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE_NAME), defaultCryptoProvider);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Mirrors MlsCryptoContextService's restoreClientState() exactly, so tests
// can inspect group state (membership) the same way production code does.
function restoreClientState(base64: string): ClientState {
  const decoded = decodeGroupState(base64ToBytes(base64), 0);
  if (!decoded) throw new Error('test fixture: failed to decode group state');
  const [groupState] = decoded;
  const clientConfig: ClientConfig = {
    keyRetentionConfig:       { ...defaultKeyRetentionConfig, retainKeysForEpochs: 50 },
    lifetimeConfig:           defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig:            defaultPaddingConfig,
    authService:              defaultAuthenticationService,
  };
  return { ...groupState, clientConfig };
}

function memberIdentities(base64: string): string[] {
  const dec = new TextDecoder();
  return getGroupMembers(restoreClientState(base64))
    .filter(m => m.credential.credentialType === 'basic')
    .map(m => dec.decode((m.credential as { identity: Uint8Array }).identity));
}

async function makeKeyPackageB64(identity: string, cs: Awaited<ReturnType<typeof getCs>>): Promise<string> {
  const credential = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identity) };
  const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
  return bytesToBase64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage: kp.publicPackage }));
}

// Creates a fresh 1-member MLS group (just `identity`), matching exactly how
// MlsService.ensureGroupReady() creates a group for the initiator.
async function makeInitialGroup(convId: string, identity: string) {
  const cs = await getCs();
  const credential = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identity) };
  const kp = await generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], cs);
  const groupId = new TextEncoder().encode(convId);
  const state = await createGroup(groupId, kp.publicPackage, kp.privatePackage, [], cs);
  return { cs, stateB64: bytesToBase64(encodeGroupState(state)) };
}

// Builds a valid Add commit from `stateB64` at its current epoch — used to
// simulate "another device's winning commit for the same epoch" independent
// of whatever provisionDevice() itself is doing with its own copy of the state.
async function commitAdd(stateB64: string, cs: Awaited<ReturnType<typeof getCs>>, newIdentity: string) {
  const clientState = restoreClientState(stateB64);
  const kpB64 = await makeKeyPackageB64(newIdentity, cs);
  const decodedKP = decodeMlsMessage(base64ToBytes(kpB64), 0)?.[0];
  if (!decodedKP || decodedKP.wireformat !== 'mls_key_package') throw new Error('test fixture: bad key package');
  const addProposal: ProposalAdd = { proposalType: 'add', add: { keyPackage: decodedKP.keyPackage } };
  const { newState, commit } = await createCommit(
    { state: clientState, cipherSuite: cs },
    { extraProposals: [addProposal], wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  return {
    commitB64:   bytesToBase64(encodeMlsMessage(commit)),
    newStateB64: bytesToBase64(encodeGroupState(newState)),
    // The epoch a commit is stored/keyed under is the epoch it was BUILT
    // FROM, not the resulting epoch after applying it (see AUDIT_02/03 and
    // mls-commit.service.ts's applyCommit) -- matches storeMlsCommit's and
    // processIncomingCommit's convention so a "winning commit" fixture built
    // here round-trips through applyCommit without a spurious EpochGapError.
    epoch:       Number(clientState.groupContext.epoch),
  };
}

// In-memory stand-in for MlsStateStorageService — same load/update contract,
// no IndexedDB/WebCrypto-at-rest involved (tested separately elsewhere).
//
// update() mirrors the real MlsStateStorageService.withLock()'s per-scope
// promise chaining (load -> updater -> save, queued behind any in-flight
// call for the same scope) rather than just doing load/updater/save inline.
// This is required, not cosmetic: a same-scope re-entrant update() call
// (e.g. one issued from inside another update()'s updater) queues behind
// the outer call's own gate here exactly as it does in production, so a
// test can actually reproduce (and pin the fix for) the deadlock in
// removeRevokedDeviceFromAllGroups — see that describe block below.
class FakeMlsStorage {
  private readonly store = new Map<string, StoredMlsState>();
  private readonly locks = new Map<string, Promise<unknown>>();

  seed(scope: string, state: StoredMlsState): void {
    this.store.set(scope, JSON.parse(JSON.stringify(state)));
  }

  async load<T>(scope: string): Promise<T | null> {
    const value = this.store.get(scope);
    return value ? (JSON.parse(JSON.stringify(value)) as T) : null;
  }

  update<T>(scope: string, updater: (state: T | null) => Promise<T | null>): Promise<void> {
    const prev = this.locks.get(scope) ?? Promise.resolve<unknown>(undefined);
    const current: Promise<void> = prev.then(
      () => this.runUpdate(scope, updater),
      () => this.runUpdate(scope, updater),
    );
    const gate: Promise<unknown> = current.then(() => undefined, () => undefined);
    this.locks.set(scope, gate);
    void gate.then(() => {
      if (this.locks.get(scope) === gate) this.locks.delete(scope);
    });
    return current;
  }

  private async runUpdate<T>(scope: string, updater: (state: T | null) => Promise<T | null>): Promise<void> {
    const current = await this.load<T>(scope);
    const next = await updater(current);
    if (next !== null) this.store.set(scope, next as unknown as StoredMlsState);
  }
}

describe('MlsMembershipService — commit lock behavior (provisionDevice / removeRevokedDeviceFromAllGroups / reprovisionLostStateDevice)', () => {
  let service: MlsMembershipService;
  let mockRepo: jasmine.SpyObj<MlsRepository>;
  let fakeStorage: FakeMlsStorage;
  let pendingCommitTracker: MlsPendingCommitTracker;

  const USER: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const DEVICE: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
  const CONV_ID = 'conv-1';
  const SCOPE = `mls:${USER.did}:${DEVICE.id}`;

  function baseState(groupStates: Record<string, string>): StoredMlsState {
    return {
      version:            1,
      userDid:            USER.did,
      deviceId:           DEVICE.id,
      deviceName:         DEVICE.name,
      platform:           DEVICE.platform,
      cipherSuiteName:    CIPHERSUITE_NAME,
      credentialIdentity: `${USER.did}#${DEVICE.id}`,
      keyPackages:        [],
      conversations:      {},
      groupStates,
      initializedAt:      Date.now(),
      updatedAt:          Date.now(),
    };
  }

  beforeEach(() => {
    mockRepo = jasmine.createSpyObj<MlsRepository>('MlsRepository', ['acquireCommitLock', 'consumeOwnKeyPackage', 'postCommit']);
    fakeStorage = new FakeMlsStorage();

    TestBed.configureTestingModule({
      providers: [
        MlsMembershipService,
        { provide: MlsRepository, useValue: mockRepo },
        { provide: MlsStateStorageService, useValue: fakeStorage },
      ],
    });
    service = TestBed.inject(MlsMembershipService);
    pendingCommitTracker = TestBed.inject(MlsPendingCommitTracker);
  });

  describe('provisionDevice', () => {
    it('waits for an in-progress incoming commit to finish applying before starting', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));

      // Simulate a processIncomingCommit() already in flight for this
      // conversation by seeding the shared MlsPendingCommitTracker directly —
      // there's no public seam for "an incoming commit is being applied".
      let resolveIncoming!: () => void;
      const blocking = new Promise<void>(resolve => { resolveIncoming = resolve; });
      pendingCommitTracker.set(CONV_ID, blocking);

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      let settled = false;
      const provisionPromise = service.provisionDevice('device-new', CONV_ID, USER, DEVICE)
        .then(() => { settled = true; });

      // Flush pending microtasks — provisionDevice must still be blocked on
      // the incoming commit, so it must not have reached the lock check yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(mockRepo.acquireCommitLock).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      resolveIncoming();
      await provisionPromise;

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(settled).toBe(true);
    });

    it('skips cleanly without building a commit when the lock is held by another device', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      await service.provisionDevice('device-new', CONV_ID, USER, DEVICE);

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(mockRepo.consumeOwnKeyPackage).not.toHaveBeenCalled();
    });

    it('proceeds to build a commit once the lock is acquired', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      // Stop the test right after the lock check — proves it got past the
      // "skip on denial" branch without needing to drive the rest of the flow.
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.reject(new Error('stop-test-sentinel')));

      await expectAsync(service.provisionDevice('device-new', CONV_ID, USER, DEVICE))
        .toBeRejectedWithError('stop-test-sentinel');

      expect(mockRepo.consumeOwnKeyPackage).toHaveBeenCalledWith('device-new');
    });

    it('proceeds anyway when acquiring the lock fails over the network (not treated as denial)', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.reject(new Error('network down')));
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.reject(new Error('stop-test-sentinel')));

      await expectAsync(service.provisionDevice('device-new', CONV_ID, USER, DEVICE))
        .toBeRejectedWithError('stop-test-sentinel');

      expect(mockRepo.consumeOwnKeyPackage).toHaveBeenCalledWith('device-new');
    });

    it('detects a lost commit race after posting and resyncs onto the winning commit instead of forking', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: initialStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));

      const loserKpB64 = await makeKeyPackageB64('did:plc:bob#device-loser', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: loserKpB64, deviceId: 'device-loser' }));

      // Another device races for the SAME epoch (built independently from the
      // same base state) and wins — this is exactly the session's core bug.
      const winner = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-winner');
      mockRepo.postCommit.and.returnValue(Promise.resolve({
        id:             'commit-1',
        conversationId: CONV_ID,
        senderDeviceId: 'device-a2', // not us
        commit:         winner.commitB64,
        epoch:          winner.epoch,
        createdAt:      Date.now(),
      }));

      await service.provisionDevice('device-loser', CONV_ID, USER, DEVICE);

      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      const identities = memberIdentities(finalState!.groupStates[CONV_ID]!);

      expect(identities).toContain('did:plc:bob#device-winner');
      expect(identities).not.toContain('did:plc:bob#device-loser');
    });

    // Forensic audit finding F10: the lost-race rollback used to unconditionally
    // overwrite groupStates[conversationId] with the pre-optimistic-write
    // snapshot, discarding anything a genuinely different concurrent operation
    // had already written in between. The fix is a compare-and-swap: only roll
    // back if our own optimistic write is still the current value.
    it('does not clobber a concurrent write when rolling back after a lost commit race', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: initialStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      const loserKpB64 = await makeKeyPackageB64('did:plc:bob#device-loser', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: loserKpB64, deviceId: 'device-loser' }));

      const winner = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-winner');

      // Simulate a genuinely different concurrent write landing on this
      // conversation's state AFTER our optimistic write but BEFORE our
      // rollback executes -- e.g. another in-flight operation applying a
      // real commit for this same conversation. postCommit() is the only
      // seam that runs after the storage lock releases (see R1), so faking
      // its implementation to also touch storage is the realistic place to
      // inject this.
      const concurrent = await commitAdd(initialStateB64, cs, 'did:plc:carol#device-concurrent');
      mockRepo.postCommit.and.callFake(async () => {
        await fakeStorage.update<StoredMlsState>(SCOPE, async (s) => {
          if (!s) return null;
          s.groupStates[CONV_ID] = concurrent.newStateB64;
          return s;
        });
        return {
          id: 'commit-1', conversationId: CONV_ID, senderDeviceId: 'device-a2', // not us -- lost race
          commit: winner.commitB64, epoch: winner.epoch, createdAt: Date.now(),
        };
      });

      // Not under test here -- replaying winner's commit against the
      // concurrent tree is a real crypto mismatch (they diverged from the
      // same base); swallow it so it doesn't fail this test. processIncomingCommit
      // now lives on the injected MlsCommitService, not on this service itself.
      spyOn(TestBed.inject(MlsCommitService), 'processIncomingCommit').and.returnValue(Promise.resolve());

      await service.provisionDevice('device-loser', CONV_ID, USER, DEVICE);

      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      // Must still reflect the concurrent write, NOT the stale
      // pre-optimistic-write snapshot (initialStateB64) the old unconditional
      // rollback would have clobbered it with.
      expect(finalState!.groupStates[CONV_ID]).toBe(concurrent.newStateB64);
    });

    // Baseline pin-down (see Phase 8b / AUDIT_02 Root Cause #3): this guard is
    // correct for a genuine TOCTOU race between two concurrent provisions of a
    // brand-new device, but it also fires — permanently — for a device that
    // lost local state while remaining a tree member, which is exactly why
    // reprovisionLostStateDevice() exists below.
    it('skips without posting a commit when the target device is already a member of the tree (TOCTOU guard)', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-existing');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      const kpB64 = await makeKeyPackageB64('did:plc:bob#device-existing', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: kpB64, deviceId: 'device-existing' }));

      await service.provisionDevice('device-existing', CONV_ID, USER, DEVICE);

      expect(mockRepo.postCommit).not.toHaveBeenCalled();
      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      expect(finalState!.groupStates[CONV_ID]).toBe(added.newStateB64);
    });
  });

  describe('reprovisionLostStateDevice', () => {
    it('waits for an in-progress incoming commit to finish applying before starting', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      let resolveIncoming!: () => void;
      const blocking = new Promise<void>(resolve => { resolveIncoming = resolve; });
      pendingCommitTracker.set(CONV_ID, blocking);

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      let settled = false;
      const reprovisionPromise = service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE)
        .then(() => { settled = true; });

      await Promise.resolve();
      await Promise.resolve();
      expect(mockRepo.acquireCommitLock).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      resolveIncoming();
      await reprovisionPromise;

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(settled).toBe(true);
    });

    it('skips cleanly without building a commit when the lock is held by another device', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      await service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE);

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(mockRepo.consumeOwnKeyPackage).not.toHaveBeenCalled();
    });

    it('proceeds to build a commit once the lock is acquired', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.reject(new Error('stop-test-sentinel')));

      await expectAsync(service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE))
        .toBeRejectedWithError('stop-test-sentinel');

      expect(mockRepo.consumeOwnKeyPackage).toHaveBeenCalledWith('device-stale');
    });

    it('proceeds anyway when acquiring the lock fails over the network (not treated as denial)', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.reject(new Error('network down')));
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.reject(new Error('stop-test-sentinel')));

      await expectAsync(service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE))
        .toBeRejectedWithError('stop-test-sentinel');

      expect(mockRepo.consumeOwnKeyPackage).toHaveBeenCalledWith('device-stale');
    });

    it('skips idempotently when the target device is not (or no longer) a member of the tree', async () => {
      const { cs, stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      const kpB64 = await makeKeyPackageB64('did:plc:bob#device-gone', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: kpB64, deviceId: 'device-gone' }));

      await service.reprovisionLostStateDevice('device-gone', CONV_ID, USER, DEVICE);

      expect(mockRepo.postCommit).not.toHaveBeenCalled();
    });

    // Core regression test (see Phase 8b): this is the exact scenario where
    // provisionDevice() would silently skip forever (pinned above) — proves
    // the Remove+Add combined commit succeeds instead, producing a fresh
    // Welcome for the stale device without duplicating its membership.
    it('removes the stale leaf and re-adds the device fresh in a single commit, producing a Welcome — where provisionDevice would silently skip', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      const freshKpB64 = await makeKeyPackageB64('did:plc:bob#device-stale', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: freshKpB64, deviceId: 'device-stale' }));
      mockRepo.postCommit.and.callFake((_convId: string, commit: string, epoch: number) => Promise.resolve({
        id: 'commit-1', conversationId: CONV_ID, senderDeviceId: DEVICE.id, commit, epoch, createdAt: Date.now(),
      }));

      await service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE);

      expect(mockRepo.postCommit).toHaveBeenCalled();
      const [, , , welcomesArg] = mockRepo.postCommit.calls.mostRecent().args as [string, string, number, Array<{ targetDeviceId: string; welcome: string }>];
      expect(welcomesArg).toHaveSize(1);
      expect(welcomesArg[0].targetDeviceId).toBe('device-stale');
      expect(welcomesArg[0].welcome).toBeTruthy();

      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      const identities = memberIdentities(finalState!.groupStates[CONV_ID]!);
      expect(identities.filter(id => id === 'did:plc:bob#device-stale').length).toBe(1);
    });

    it('detects a lost commit race after posting and resyncs onto the winning commit instead of forking', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-stale');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      const freshKpB64 = await makeKeyPackageB64('did:plc:bob#device-stale', cs);
      mockRepo.consumeOwnKeyPackage.and.returnValue(Promise.resolve({ keyPackage: freshKpB64, deviceId: 'device-stale' }));

      // Another device races for the SAME epoch (built independently from the
      // same base state) and wins.
      const winner = await commitAdd(added.newStateB64, cs, 'did:plc:carol#device-winner');
      mockRepo.postCommit.and.returnValue(Promise.resolve({
        id:             'commit-1',
        conversationId: CONV_ID,
        senderDeviceId: 'device-a2', // not us
        commit:         winner.commitB64,
        epoch:          winner.epoch,
        createdAt:      Date.now(),
      }));

      await service.reprovisionLostStateDevice('device-stale', CONV_ID, USER, DEVICE);

      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      const identities = memberIdentities(finalState!.groupStates[CONV_ID]!);
      expect(identities).toContain('did:plc:carol#device-winner');
    });
  });

  describe('removeRevokedDeviceFromAllGroups', () => {
    it('waits for an in-progress incoming commit on that conversation before starting', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));

      let resolveIncoming!: () => void;
      const blocking = new Promise<void>(resolve => { resolveIncoming = resolve; });
      pendingCommitTracker.set(CONV_ID, blocking);

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      let settled = false;
      const removePromise = service.removeRevokedDeviceFromAllGroups('device-revoked', USER, DEVICE)
        .then(() => { settled = true; });

      await Promise.resolve();
      await Promise.resolve();
      expect(mockRepo.acquireCommitLock).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      resolveIncoming();
      await removePromise;

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(settled).toBe(true);
    });

    it('skips a conversation whose commit lock is held by another device', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: false }));

      await service.removeRevokedDeviceFromAllGroups('device-revoked', USER, DEVICE);

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(mockRepo.postCommit).not.toHaveBeenCalled();
      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      expect(finalState!.groupStates[CONV_ID]).toBe(stateB64);
    });

    it('proceeds to inspect membership once the lock is acquired (no-op if the device is not a member)', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));
      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));

      await service.removeRevokedDeviceFromAllGroups('device-not-a-member', USER, DEVICE);

      expect(mockRepo.acquireCommitLock).toHaveBeenCalledWith(CONV_ID);
      expect(mockRepo.postCommit).not.toHaveBeenCalled();
    });

    it('proceeds and removes the device when acquiring the lock fails over the network', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-revoked');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.reject(new Error('network down')));
      mockRepo.postCommit.and.callFake((_convId: string, commit: string, epoch: number) => Promise.resolve({
        id: 'commit-1', conversationId: CONV_ID, senderDeviceId: DEVICE.id, commit, epoch, createdAt: Date.now(),
      }));

      await service.removeRevokedDeviceFromAllGroups('device-revoked', USER, DEVICE);

      expect(mockRepo.postCommit).toHaveBeenCalled();
      const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
      const identities = memberIdentities(finalState!.groupStates[CONV_ID]!);
      expect(identities).not.toContain('did:plc:bob#device-revoked');
    });

    // Regression test for the self-deadlock bug (forensic audit finding F1):
    // the 409 handler below calls clearConversationGroup(), which itself
    // calls storage.update() on the SAME scope. Before the fix, postCommit()
    // and that 409 handler both ran INSIDE this method's own storage.update()
    // updater, so the outer update()'s lock gate could never settle while
    // clearConversationGroup()'s inner update() queued behind it -- this
    // device's entire MLS storage lock would stay stuck until an app restart.
    it('does not deadlock the storage lock when postCommit returns a 409 epoch conflict', async () => {
      const identity = `${USER.did}#${DEVICE.id}`;
      const { cs, stateB64: initialStateB64 } = await makeInitialGroup(CONV_ID, identity);
      const added = await commitAdd(initialStateB64, cs, 'did:plc:bob#device-revoked');
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: added.newStateB64 }));

      mockRepo.acquireCommitLock.and.returnValue(Promise.resolve({ acquired: true }));
      mockRepo.postCommit.and.returnValue(Promise.reject(new HttpErrorResponse({ status: 409 })));

      const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, reject) => setTimeout(
            () => reject(new Error(`timed out after ${ms}ms -- storage lock likely deadlocked`)), ms,
          )),
        ]);

      await withTimeout(service.removeRevokedDeviceFromAllGroups('device-revoked', USER, DEVICE), 2000);

      // A same-scope storage.update() issued right after must also complete
      // promptly -- proves the lock was actually released, not just that the
      // outer call happened to resolve on its own.
      let ranAfter = false;
      await withTimeout(
        fakeStorage.update<StoredMlsState>(SCOPE, async (s) => { ranAfter = true; return s; }),
        2000,
      );
      expect(ranAfter).toBe(true);
    });
  });
});
