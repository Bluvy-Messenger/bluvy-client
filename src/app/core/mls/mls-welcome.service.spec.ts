import { TestBed } from '@angular/core/testing';
import {
  createGroup,
  createCommit,
  generateKeyPackage,
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  defaultCryptoProvider,
  defaultCapabilities,
  defaultLifetime,
  encodeMlsMessage,
  type ProposalAdd,
} from 'ts-mls';
import { MlsWelcomeService } from './mls-welcome.service';
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

// In-memory stand-in for MlsStateStorageService -- same load/update contract
// used by mls.service.spec.ts's FakeMlsStorage, trimmed to what this spec needs.
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

const USER: UserProfile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol', avatarUrl: null };
const DEVICE: DeviceInfo = { id: 'device-c1', name: 'Phone', platform: 'android' };
const CONV_ID = 'conv-welcome-nomatch';
const SCOPE = `mls:${USER.did}:${DEVICE.id}`;

function baseState(keyPackages: StoredMlsState['keyPackages']): StoredMlsState {
  return {
    version:            1,
    userDid:            USER.did,
    deviceId:           DEVICE.id,
    deviceName:         DEVICE.name,
    platform:           DEVICE.platform,
    cipherSuiteName:    CIPHERSUITE_NAME,
    credentialIdentity: `${USER.did}#${DEVICE.id}`,
    keyPackages,
    conversations:      {},
    groupStates:        {},
    initializedAt:      Date.now(),
    updatedAt:          Date.now(),
  };
}

describe('MlsWelcomeService', () => {
  // ── processWelcomeForConversation: no matching KeyPackage (forensic audit
  // finding F7) — relocated verbatim from mls.service.spec.ts (Phase 1 Step 1).
  //
  // Before the fix, an unmatched Welcome was ACKed (marking the server row
  // consumed) before throwing. That row is the only copy of this device's
  // group secrets -- ACKing it turned a transient cause (KP pool not yet
  // refilled, a device-identity scope mismatch) into a permanent loss, since
  // the durable-retry design (getPendingWelcomes re-serving unconsumed rows on
  // every poll) can't recover a row the server has already marked consumed.
  describe('processWelcomeForConversation (no matching KeyPackage)', () => {
    let service: MlsWelcomeService;
    let mockRepo: jasmine.SpyObj<MlsRepository>;
    let fakeStorage: FakeMlsStorage;

    beforeEach(() => {
      mockRepo = jasmine.createSpyObj<MlsRepository>('MlsRepository', ['ackWelcome']);
      fakeStorage = new FakeMlsStorage();

      TestBed.configureTestingModule({
        providers: [
          MlsWelcomeService,
          { provide: MlsRepository, useValue: mockRepo },
          { provide: MlsStateStorageService, useValue: fakeStorage },
        ],
      });
      service = TestBed.inject(MlsWelcomeService);
    });

    it('does NOT ack the Welcome when no local key package matches, so the durable retry can still recover it', async () => {
      const cs = await getCs();
      const founderIdentity = 'did:plc:alice#device-founder';
      const kpFounder = await generateKeyPackage(
        { credentialType: 'basic' as const, identity: new TextEncoder().encode(founderIdentity) },
        defaultCapabilities(), defaultLifetime, [], cs,
      );
      const groupId = new TextEncoder().encode(CONV_ID);
      const stateFounder = await createGroup(groupId, kpFounder.publicPackage, kpFounder.privatePackage, [], cs);

      const joinerIdentity = `${USER.did}#${DEVICE.id}`;
      const kpJoiner = await generateKeyPackage(
        { credentialType: 'basic' as const, identity: new TextEncoder().encode(joinerIdentity) },
        defaultCapabilities(), defaultLifetime, [], cs,
      );
      const addJoiner: ProposalAdd = { proposalType: 'add', add: { keyPackage: kpJoiner.publicPackage } };
      const commit = await createCommit(
        { state: stateFounder, cipherSuite: cs },
        { extraProposals: [addJoiner], wireAsPublicMessage: true, ratchetTreeExtension: true },
      );
      if (!commit.welcome) throw new Error('test fixture: expected a welcome');

      const welcomeB64 = bytesToBase64(encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome: commit.welcome }));

      // Local state has NO key packages at all -- guarantees the "no matching
      // KP" branch deterministically, without needing to fabricate a specific
      // ref mismatch against the real Welcome above.
      fakeStorage.seed(SCOPE, baseState([]));

      await expectAsync(
        service.processWelcomeForConversation('welcome-1', welcomeB64, CONV_ID, USER, DEVICE),
      ).toBeRejectedWithError(/No matching key package/);

      expect(mockRepo.ackWelcome).not.toHaveBeenCalled();
    });
  });

  // ── fetchAndProcessPendingWelcome — no direct coverage before this split;
  // isolates the fetch/loop/error-tolerance orchestration from
  // processWelcomeForConversation's crypto, which is covered separately above.
  describe('fetchAndProcessPendingWelcome', () => {
    let service: MlsWelcomeService;
    let mockRepo: jasmine.SpyObj<MlsRepository>;

    beforeEach(() => {
      mockRepo = jasmine.createSpyObj<MlsRepository>('MlsRepository', ['getPendingWelcomes']);
      TestBed.configureTestingModule({
        providers: [
          MlsWelcomeService,
          { provide: MlsRepository, useValue: mockRepo },
        ],
      });
      service = TestBed.inject(MlsWelcomeService);
    });

    it('returns false and processes nothing when there are no pending Welcomes', async () => {
      mockRepo.getPendingWelcomes.and.returnValue(Promise.resolve({ data: [] }));
      const processSpy = spyOn(service, 'processWelcomeForConversation');

      const result = await service.fetchAndProcessPendingWelcome(CONV_ID, USER, DEVICE);

      expect(result).toBe(false);
      expect(processSpy).not.toHaveBeenCalled();
    });

    it('processes every pending Welcome and returns true when all succeed', async () => {
      mockRepo.getPendingWelcomes.and.returnValue(Promise.resolve({
        data: [
          { id: 'w1', conversationId: CONV_ID, welcome: 'b64-1', createdAt: 1 },
          { id: 'w2', conversationId: CONV_ID, welcome: 'b64-2', createdAt: 2 },
        ],
      }));
      const processSpy = spyOn(service, 'processWelcomeForConversation').and.returnValue(Promise.resolve());

      const result = await service.fetchAndProcessPendingWelcome(CONV_ID, USER, DEVICE);

      expect(result).toBe(true);
      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(processSpy).toHaveBeenCalledWith('w1', 'b64-1', CONV_ID, USER, DEVICE);
      expect(processSpy).toHaveBeenCalledWith('w2', 'b64-2', CONV_ID, USER, DEVICE);
    });

    it('tolerates a failure on one Welcome and still processes and reports the rest', async () => {
      mockRepo.getPendingWelcomes.and.returnValue(Promise.resolve({
        data: [
          { id: 'w1', conversationId: CONV_ID, welcome: 'b64-1', createdAt: 1 },
          { id: 'w2', conversationId: CONV_ID, welcome: 'b64-2', createdAt: 2 },
        ],
      }));
      const processSpy = spyOn(service, 'processWelcomeForConversation').and.callFake((id: string | null) =>
        id === 'w1' ? Promise.reject(new Error('boom')) : Promise.resolve(),
      );

      const result = await service.fetchAndProcessPendingWelcome(CONV_ID, USER, DEVICE);

      expect(result).toBe(true);
      expect(processSpy).toHaveBeenCalledTimes(2);
    });

    it('returns false if every pending Welcome fails to process', async () => {
      mockRepo.getPendingWelcomes.and.returnValue(Promise.resolve({
        data: [{ id: 'w1', conversationId: CONV_ID, welcome: 'b64-1', createdAt: 1 }],
      }));
      spyOn(service, 'processWelcomeForConversation').and.returnValue(Promise.reject(new Error('boom')));

      const result = await service.fetchAndProcessPendingWelcome(CONV_ID, USER, DEVICE);

      expect(result).toBe(false);
    });
  });
});
