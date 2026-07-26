import { TestBed } from '@angular/core/testing';
import {
  createGroup,
  createCommit,
  joinGroup,
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
  emptyPskIndex,
  encodeGroupState,
  decodeGroupState,
  encodeMlsMessage,
  decodeMlsMessage,
  type ClientConfig,
  type ClientState,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { MlsService } from './mls.service';
import { MlsRepository } from './mls.repository';
import { MlsStateStorageService } from './mls-state-storage.service';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { StoredMlsState } from './mls.types';

// ── Real-MLS test fixtures ─────────────────────────────────────────────────
// The commit-lock behavior under test here (provisionDevice /
// removeRevokedDeviceFromAllGroups) sits around real ts-mls crypto calls
// (createCommit, decodeGroupState, ...) made directly in mls.service.ts, not
// behind an injectable seam. So instead of mocking crypto, these tests build
// small real MLS groups with ts-mls itself (same functions, same options,
// as production code) and only mock the two injected collaborators:
// MlsRepository (network) and MlsStateStorageService (IndexedDB).

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

// Mirrors MlsService's private restoreClientState() exactly, so tests can
// inspect group state (membership) the same way production code does.
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
    epoch:       Number(newState.groupContext.epoch),
  };
}

// In-memory stand-in for MlsStateStorageService — same load/update contract,
// no IndexedDB/WebCrypto-at-rest involved (tested separately elsewhere).
class FakeMlsStorage {
  private readonly store = new Map<string, StoredMlsState>();

  seed(scope: string, state: StoredMlsState): void {
    this.store.set(scope, JSON.parse(JSON.stringify(state)));
  }

  async load<T>(scope: string): Promise<T | null> {
    const value = this.store.get(scope);
    return value ? (JSON.parse(JSON.stringify(value)) as T) : null;
  }

  async update<T>(scope: string, updater: (state: T | null) => Promise<T | null>): Promise<void> {
    const current = await this.load<T>(scope);
    const next = await updater(current);
    if (next !== null) this.store.set(scope, next as unknown as StoredMlsState);
  }
}

describe('MlsService — commit lock behavior (provisionDevice / removeRevokedDeviceFromAllGroups)', () => {
  let service: MlsService;
  let mockRepo: jasmine.SpyObj<MlsRepository>;
  let fakeStorage: FakeMlsStorage;

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
        MlsService,
        { provide: MlsRepository, useValue: mockRepo },
        { provide: MlsStateStorageService, useValue: fakeStorage },
      ],
    });
    service = TestBed.inject(MlsService);
  });

  describe('provisionDevice', () => {
    it('waits for an in-progress incoming commit to finish applying before starting', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));

      // Simulate a processIncomingCommit() already in flight for this
      // conversation by seeding the private pendingCommits map directly —
      // there's no public seam for "an incoming commit is being applied".
      let resolveIncoming!: () => void;
      const blocking = new Promise<void>(resolve => { resolveIncoming = resolve; });
      (service as unknown as { pendingCommits: Map<string, Promise<void>> })
        .pendingCommits.set(CONV_ID, blocking);

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
  });

  describe('removeRevokedDeviceFromAllGroups', () => {
    it('waits for an in-progress incoming commit on that conversation before starting', async () => {
      const { stateB64 } = await makeInitialGroup(CONV_ID, `${USER.did}#${DEVICE.id}`);
      fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: stateB64 }));

      let resolveIncoming!: () => void;
      const blocking = new Promise<void>(resolve => { resolveIncoming = resolve; });
      (service as unknown as { pendingCommits: Map<string, Promise<void>> })
        .pendingCommits.set(CONV_ID, blocking);

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
  });
});

// ── applyCommit epoch guard (Root Cause #1 — see AUDIT_02/03) ────────────────
//
// Empirically validated in AUDIT_03_VALIDATION_RESULTS.md by executing real
// ts-mls directly: a non-committing existing member's local epoch is, by MLS's
// own consistency requirement, exactly equal to an incoming commit's declared
// (pre-commit) epoch. Before the fix, applyCommit's `currentEpoch >= epoch`
// guard treated that legitimate case identically to "already applied" and
// silently discarded the commit. This test drives the exact same scenario
// through the real MlsService class (not a re-implementation of the guard).
describe('MlsService — applyCommit epoch guard (Root Cause #1)', () => {
  let service: MlsService;
  let mockRepo: jasmine.SpyObj<MlsRepository>;
  let fakeStorage: FakeMlsStorage;

  const USER: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
  const DEVICE: DeviceInfo = { id: 'device-b1', name: 'Phone', platform: 'android' };
  const CONV_ID = 'conv-guard';
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
        MlsService,
        { provide: MlsRepository, useValue: mockRepo },
        { provide: MlsStateStorageService, useValue: fakeStorage },
      ],
    });
    service = TestBed.inject(MlsService);
  });

  it('applies an incoming commit whose declared epoch exactly equals the local current epoch, instead of discarding it as already-applied', async () => {
    const cs = await getCs();
    const identityA = 'did:plc:alice#device-a1';
    const identityB = `${USER.did}#${DEVICE.id}`;
    const identityC = 'did:plc:alice#device-a2';

    // Device A creates the group (epoch 0) and adds device B via the founding commit (epoch 0 -> 1).
    const credA = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityA) };
    const kpA   = await generateKeyPackage(credA, defaultCapabilities(), defaultLifetime, [], cs);
    const groupId = new TextEncoder().encode(CONV_ID);
    const stateA0 = await createGroup(groupId, kpA.publicPackage, kpA.privatePackage, [], cs);

    const credB = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityB) };
    const kpB   = await generateKeyPackage(credB, defaultCapabilities(), defaultLifetime, [], cs);
    const addB: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpB.publicPackage } };
    const commit1 = await createCommit(
      { state: stateA0, cipherSuite: cs },
      { extraProposals: [addB], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    if (!commit1.welcome) throw new Error('test fixture: expected a welcome for the founding add');

    // Device B joins via a genuine real Welcome -- this is B's authentic ClientState, not a stand-in.
    const bStateAfterJoin = await joinGroup(commit1.welcome, kpB.publicPackage, kpB.privatePackage, emptyPskIndex, cs);
    expect(Number(bStateAfterJoin.groupContext.epoch)).toBe(1); // matches AUDIT_03's captured trace step [5]
    fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: bytesToBase64(encodeGroupState(bStateAfterJoin)) }));

    // Device A (already at epoch 1, from commit1.newState) now adds a third device -- commit#2, built
    // exactly as MlsService.provisionDevice does: read currentEpoch from the PRE-commit state.
    const stateA1 = commit1.newState;
    const postedEpoch = Number(stateA1.groupContext.epoch); // == 1, exactly what mls.service.ts posts (see :765, :277)
    expect(postedEpoch).toBe(1); // the boundary case this test targets: equals B's current epoch exactly

    const credC = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityC) };
    const kpC   = await generateKeyPackage(credC, defaultCapabilities(), defaultLifetime, [], cs);
    const addC: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpC.publicPackage } };
    const commit2 = await createCommit(
      { state: stateA1, cipherSuite: cs },
      { extraProposals: [addC], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    const commit2B64 = bytesToBase64(encodeMlsMessage(commit2.commit));

    // Device B receives commit#2 exactly as app.component.ts's mls:commit handler delivers it.
    await service.processIncomingCommit(CONV_ID, commit2B64, postedEpoch, USER, DEVICE);

    const finalState = await fakeStorage.load<StoredMlsState>(SCOPE);
    const finalGroupStateB64 = finalState!.groupStates[CONV_ID]!;
    const finalEpoch   = Number(restoreClientState(finalGroupStateB64).groupContext.epoch);
    const identities   = memberIdentities(finalGroupStateB64);

    // Before the fix: finalEpoch would still be 1 and identityC absent, because
    // applyCommit's `currentEpoch >= epoch` guard (1 >= 1) silently discarded
    // commit#2 with no error and no log. After the fix, B must converge to A's
    // epoch 2 with all three identities present.
    expect(finalEpoch).toBe(2);
    expect(identities).toContain(identityA);
    expect(identities).toContain(identityB);
    expect(identities).toContain(identityC);
  });

  it('still discards a genuinely already-applied commit (duplicate delivery) without re-applying it', async () => {
    const cs = await getCs();
    const identityA = 'did:plc:alice#device-a1';
    const identityB = `${USER.did}#${DEVICE.id}`;

    const credA = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityA) };
    const kpA   = await generateKeyPackage(credA, defaultCapabilities(), defaultLifetime, [], cs);
    const groupId = new TextEncoder().encode(CONV_ID);
    const stateA0 = await createGroup(groupId, kpA.publicPackage, kpA.privatePackage, [], cs);

    const credB = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityB) };
    const kpB   = await generateKeyPackage(credB, defaultCapabilities(), defaultLifetime, [], cs);
    const addB: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpB.publicPackage } };
    const commit1 = await createCommit(
      { state: stateA0, cipherSuite: cs },
      { extraProposals: [addB], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    if (!commit1.welcome) throw new Error('test fixture: expected a welcome for the founding add');

    const bStateAfterJoin = await joinGroup(commit1.welcome, kpB.publicPackage, kpB.privatePackage, emptyPskIndex, cs);
    fakeStorage.seed(SCOPE, baseState({ [CONV_ID]: bytesToBase64(encodeGroupState(bStateAfterJoin)) }));

    const stateA1 = commit1.newState;
    const postedEpoch = Number(stateA1.groupContext.epoch); // == 1
    const identityC = 'did:plc:alice#device-a2';
    const credC = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityC) };
    const kpC   = await generateKeyPackage(credC, defaultCapabilities(), defaultLifetime, [], cs);
    const addC: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpC.publicPackage } };
    const commit2 = await createCommit(
      { state: stateA1, cipherSuite: cs },
      { extraProposals: [addC], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    const commit2B64 = bytesToBase64(encodeMlsMessage(commit2.commit));

    // Apply commit#2 once, genuinely advancing B to epoch 2.
    await service.processIncomingCommit(CONV_ID, commit2B64, postedEpoch, USER, DEVICE);
    const afterFirstApply = await fakeStorage.load<StoredMlsState>(SCOPE);
    expect(Number(restoreClientState(afterFirstApply!.groupStates[CONV_ID]!).groupContext.epoch)).toBe(2);

    // Redelivery of the exact same commit (e.g. a duplicate socket event) must be a no-op,
    // not a second application against the now-epoch-2 state.
    await service.processIncomingCommit(CONV_ID, commit2B64, postedEpoch, USER, DEVICE);
    const afterRedelivery = await fakeStorage.load<StoredMlsState>(SCOPE);
    expect(afterRedelivery!.groupStates[CONV_ID]).toBe(afterFirstApply!.groupStates[CONV_ID]);
  });
});
