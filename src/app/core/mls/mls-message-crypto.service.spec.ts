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
  emptyPskIndex,
  encodeGroupState,
  type ProposalAdd,
} from 'ts-mls';
import { MlsMessageCryptoService } from './mls-message-crypto.service';
import { MlsStateStorageService } from './mls-state-storage.service';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import type { StoredMlsState } from './mls.types';

// Real-MLS test fixtures, same convention as mls-membership.service.spec.ts /
// mls-commit.service.spec.ts: build small real groups with ts-mls itself
// rather than mocking crypto, and only fake the injected MlsStateStorageService.

const CIPHERSUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;

async function getCs() {
  return getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE_NAME), defaultCryptoProvider);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

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

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-msg';
const SCOPE_A = `mls:${USER_A.did}:${DEVICE_A.id}`;
const SCOPE_B = `mls:${USER_B.did}:${DEVICE_B.id}`;

function baseState(user: UserProfile, device: DeviceInfo, groupStates: Record<string, string>): StoredMlsState {
  return {
    version:            1,
    userDid:            user.did,
    deviceId:           device.id,
    deviceName:         device.name,
    platform:           device.platform,
    cipherSuiteName:    CIPHERSUITE_NAME,
    credentialIdentity: `${user.did}#${device.id}`,
    keyPackages:        [],
    conversations:      {},
    groupStates,
    initializedAt:      Date.now(),
    updatedAt:          Date.now(),
  };
}

// Builds a real 2-member group: Alice founds it, Bob joins via a genuine
// Welcome. Returns each side's own post-join ClientState, base64-encoded
// exactly as MlsStateStorageService would store it.
async function makeTwoMemberGroup() {
  const cs = await getCs();
  const identityA = `${USER_A.did}#${DEVICE_A.id}`;
  const identityB = `${USER_B.did}#${DEVICE_B.id}`;

  const credA = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityA) };
  const kpA   = await generateKeyPackage(credA, defaultCapabilities(), defaultLifetime, [], cs);
  const groupId = new TextEncoder().encode(CONV_ID);
  const stateA0 = await createGroup(groupId, kpA.publicPackage, kpA.privatePackage, [], cs);

  const credB = { credentialType: 'basic' as const, identity: new TextEncoder().encode(identityB) };
  const kpB   = await generateKeyPackage(credB, defaultCapabilities(), defaultLifetime, [], cs);
  const addB: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpB.publicPackage } };
  const commit = await createCommit(
    { state: stateA0, cipherSuite: cs },
    { extraProposals: [addB], wireAsPublicMessage: true, ratchetTreeExtension: true },
  );
  if (!commit.welcome) throw new Error('test fixture: expected a welcome');

  const stateB = await joinGroup(commit.welcome, kpB.publicPackage, kpB.privatePackage, emptyPskIndex, cs);

  return {
    stateAB64: bytesToBase64(encodeGroupState(commit.newState)),
    stateBB64: bytesToBase64(encodeGroupState(stateB)),
  };
}

describe('MlsMessageCryptoService', () => {
  let service: MlsMessageCryptoService;
  let fakeStorage: FakeMlsStorage;

  beforeEach(() => {
    fakeStorage = new FakeMlsStorage();
    TestBed.configureTestingModule({
      providers: [
        MlsMessageCryptoService,
        { provide: MlsStateStorageService, useValue: fakeStorage },
      ],
    });
    service = TestBed.inject(MlsMessageCryptoService);
  });

  it('round-trips a plaintext message from one real group member to another', async () => {
    const { stateAB64, stateBB64 } = await makeTwoMemberGroup();
    fakeStorage.seed(SCOPE_A, baseState(USER_A, DEVICE_A, { [CONV_ID]: stateAB64 }));
    fakeStorage.seed(SCOPE_B, baseState(USER_B, DEVICE_B, { [CONV_ID]: stateBB64 }));

    const ciphertext = await service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'hello from alice');
    const plaintext  = await service.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext);

    expect(plaintext).toBe('hello from alice');
  });

  it('supports multiple sequential round trips as the group ratchet state advances', async () => {
    const { stateAB64, stateBB64 } = await makeTwoMemberGroup();
    fakeStorage.seed(SCOPE_A, baseState(USER_A, DEVICE_A, { [CONV_ID]: stateAB64 }));
    fakeStorage.seed(SCOPE_B, baseState(USER_B, DEVICE_B, { [CONV_ID]: stateBB64 }));

    const first  = await service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'message one');
    expect(await service.decryptMessage(CONV_ID, USER_B, DEVICE_B, first)).toBe('message one');

    const second = await service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'message two');
    expect(await service.decryptMessage(CONV_ID, USER_B, DEVICE_B, second)).toBe('message two');
  });

  describe('encryptMessage', () => {
    it('throws when local MLS state has never been initialized', async () => {
      await expectAsync(
        service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'hi'),
      ).toBeRejectedWithError('MLS not initialized');
    });

    it('throws when there is no group state for this conversation', async () => {
      fakeStorage.seed(SCOPE_A, baseState(USER_A, DEVICE_A, {}));

      await expectAsync(
        service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'hi'),
      ).toBeRejectedWithError('MLS group not ready for this conversation');
    });
  });

  describe('decryptMessage', () => {
    it('throws on an undecodable ciphertext', async () => {
      const { stateBB64 } = await makeTwoMemberGroup();
      fakeStorage.seed(SCOPE_B, baseState(USER_B, DEVICE_B, { [CONV_ID]: stateBB64 }));

      await expectAsync(
        service.decryptMessage(CONV_ID, USER_B, DEVICE_B, bytesToBase64(new Uint8Array([1, 2, 3]))),
      ).toBeRejectedWithError('Invalid MLS message');
    });

    it('throws when there is no group state for this conversation', async () => {
      const { stateAB64 } = await makeTwoMemberGroup();
      fakeStorage.seed(SCOPE_A, baseState(USER_A, DEVICE_A, { [CONV_ID]: stateAB64 }));
      const ciphertext = await service.encryptMessage(CONV_ID, USER_A, DEVICE_A, 'hi');

      fakeStorage.seed(SCOPE_B, baseState(USER_B, DEVICE_B, {}));

      await expectAsync(
        service.decryptMessage(CONV_ID, USER_B, DEVICE_B, ciphertext),
      ).toBeRejectedWithError('MLS group not ready for this conversation');
    });
  });
});
