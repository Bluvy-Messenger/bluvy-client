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
  type ClientConfig,
  type ClientState,
  type ProposalAdd,
} from 'ts-mls';
import { getGroupMembers } from 'ts-mls/clientState.js';
import { MlsCommitService } from './mls-commit.service';
import { MlsRepository } from './mls.repository';
import { MlsStateStorageService } from './mls-state-storage.service';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { StoredMlsState } from './mls.types';

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

// In-memory stand-in for MlsStateStorageService -- same load/update contract
// as mls.service.spec.ts's FakeMlsStorage, trimmed to what this spec needs.
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

// ── applyCommit epoch guard (Root Cause #1 — see AUDIT_02/03) ────────────────
// Relocated verbatim from mls.service.spec.ts (Phase 1 Step 2 of the split).
//
// Empirically validated in AUDIT_03_VALIDATION_RESULTS.md by executing real
// ts-mls directly: a non-committing existing member's local epoch is, by MLS's
// own consistency requirement, exactly equal to an incoming commit's declared
// (pre-commit) epoch. Before the fix, applyCommit's `currentEpoch >= epoch`
// guard treated that legitimate case identically to "already applied" and
// silently discarded the commit. This test drives the exact same scenario
// through the real MlsCommitService class (not a re-implementation of the guard).
describe('MlsCommitService — applyCommit epoch guard (Root Cause #1)', () => {
  let service: MlsCommitService;
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
        MlsCommitService,
        { provide: MlsRepository, useValue: mockRepo },
        { provide: MlsStateStorageService, useValue: fakeStorage },
      ],
    });
    service = TestBed.inject(MlsCommitService);
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
    // exactly as provisionDevice does: read currentEpoch from the PRE-commit state.
    const stateA1 = commit1.newState;
    const postedEpoch = Number(stateA1.groupContext.epoch); // == 1
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

  // Forensic audit finding F8, empirically validated: feeding ts-mls a commit
  // built from an epoch AHEAD of the local state throws
  // CryptoVerificationError "Could not verify membership" -- a message
  // indistinguishable from a genuine crypto/fork failure. applyCommit must
  // detect this gap (epoch > currentEpoch) itself and throw EpochGapError
  // instead of ever reaching processPublicMessage with it.
  it('throws EpochGapError instead of calling processPublicMessage when the incoming commit is ahead of the local epoch (a missed commit, not a fork)', async () => {
    const cs = await getCs();
    const identityA = 'did:plc:alice#device-a1';
    const identityB = `${USER.did}#${DEVICE.id}`;
    const identityC = 'did:plc:alice#device-a2';
    const identityD = 'did:plc:alice#device-a3';

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

    // Commit#2 (epoch 1 -> 2): B never receives/applies this one -- simulates
    // a missed commit (e.g. dropped socket event, brief disconnect).
    const credC = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityC) };
    const kpC   = await generateKeyPackage(credC, defaultCapabilities(), defaultLifetime, [], cs);
    const addC: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpC.publicPackage } };
    const commit2 = await createCommit(
      { state: commit1.newState, cipherSuite: cs },
      { extraProposals: [addC], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );

    // Commit#3 (epoch 2 -> 3): B receives THIS one directly, skipping commit#2
    // entirely -- declared epoch (2) > B's local epoch (1).
    const credD = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityD) };
    const kpD   = await generateKeyPackage(credD, defaultCapabilities(), defaultLifetime, [], cs);
    const addD: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpD.publicPackage } };
    const commit3 = await createCommit(
      { state: commit2.newState, cipherSuite: cs },
      { extraProposals: [addD], wireAsPublicMessage: true, ratchetTreeExtension: true },
    );
    const commit3B64 = bytesToBase64(encodeMlsMessage(commit3.commit));
    const postedEpoch3 = Number(commit2.newState.groupContext.epoch); // == 2

    await expectAsync(
      service.processIncomingCommit(CONV_ID, commit3B64, postedEpoch3, USER, DEVICE),
    ).toBeRejectedWith(jasmine.objectContaining({ name: 'EpochGapError' }));

    // Local state must be untouched -- no partial/corrupt write from a failed processPublicMessage attempt.
    const stateAfter = await fakeStorage.load<StoredMlsState>(SCOPE);
    expect(Number(restoreClientState(stateAfter!.groupStates[CONV_ID]!).groupContext.epoch)).toBe(1);
  });
});
