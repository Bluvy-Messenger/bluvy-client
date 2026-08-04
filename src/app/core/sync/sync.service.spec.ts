import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { SyncService } from './sync.service';
import { SyncRepository } from './sync.repository';
import { FailedSyncBatchRepository } from './failed-sync-batch.repository';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { ConversationsService } from '../conversation/conversations.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { MlsCoordinatorService } from '../mls/coordinator/mls-coordinator.service';
import { MlsBackupRegistry } from '../mls/mls-backup-registry.service';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import { buildPinKdfParams, deriveMbkWrappingKeyFromPin, encryptMbk } from './sync.crypto';
import type { MbkBlob, SyncSettings } from './sync.types';

describe('SyncService — MBK rotation', () => {
  let service: SyncService;
  let mockSyncRepo:        jasmine.SpyObj<SyncRepository>;
  let mockFailedBatchRepo: jasmine.SpyObj<FailedSyncBatchRepository>;
  let mockConvSvc:         jasmine.SpyObj<ConversationsService>;
  let mockMessageCacheSvc: jasmine.SpyObj<MessageCacheService>;
  let mockSecureStorage:   jasmine.SpyObj<SecureLocalStorageService>;
  let mockCoordinatorSvc:  jasmine.SpyObj<MlsCoordinatorService>;
  let backupRegistry:      MlsBackupRegistry;

  const USER_DID   = 'did:plc:alice';
  const DEVICE_ID  = 'device-1';
  const PIN        = '123456';

  // A genuinely valid PIN-wrapped MBK blob (real Argon2id/HKDF/AES-GCM, same
  // helpers production code uses) -- lets verifyPin()/rotateMbk() be tested
  // against real crypto instead of a hollow mock, so these tests actually
  // mean something once Karma runs them.
  let realMbkBlob: MbkBlob;

  const defaultSettings: SyncSettings = { hasMbk: true, hasLegacyBackup: false, setupAt: 1, lastSyncAt: null, keyGeneration: 1 };

  beforeEach(async () => {
    const params       = buildPinKdfParams();
    const wrappingKey  = await deriveMbkWrappingKeyFromPin(PIN, params);
    const mbkBytes     = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
    realMbkBlob = {
      encryptedMbk: await encryptMbk(wrappingKey, mbkBytes),
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    params,
    };

    mockSyncRepo = jasmine.createSpyObj<SyncRepository>('SyncRepository', [
      'getSettings', 'getMbk', 'putMbk', 'getRecoveryMbk', 'putRecoveryMbk', 'rotateMbk',
      'getData', 'getDataIds', 'postData', 'deleteData',
    ]);
    mockFailedBatchRepo = jasmine.createSpyObj<FailedSyncBatchRepository>('FailedSyncBatchRepository', ['initialize', 'saveBatch', 'getAll', 'remove']);
    mockConvSvc         = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getConversations', 'getConversationById', 'createOrGetDm']);
    mockMessageCacheSvc = jasmine.createSpyObj<MessageCacheService>('MessageCacheService', ['isInitialized', 'initialize', 'getMessagesPage', 'getAllIds', 'getHistoryClearedAt', 'storeMany']);
    mockSecureStorage    = jasmine.createSpyObj<SecureLocalStorageService>('SecureLocalStorageService', ['storeMbk', 'loadMbk', 'clearMbk', 'hasMbk']);
    mockCoordinatorSvc   = jasmine.createSpyObj<MlsCoordinatorService>('MlsCoordinatorService', []);
    // pendingDecryptQueued$ is a real Observable property (not a spy-able
    // method) -- the constructor subscribes to it directly.
    Object.defineProperty(mockCoordinatorSvc, 'pendingDecryptQueued$', { value: new Subject(), configurable: true });

    // Sane defaults so the fast-path's fire-and-forget startFlushTimer()/
    // startBackfill() side effects (not under test here) don't throw or spam
    // console.error while background promises settle.
    mockFailedBatchRepo.initialize.and.returnValue(Promise.resolve());
    mockSecureStorage.hasMbk.and.returnValue(Promise.resolve(false));
    mockSyncRepo.getSettings.and.returnValue(Promise.resolve(defaultSettings));
    mockMessageCacheSvc.isInitialized.and.returnValue(true);
    mockConvSvc.getConversations.and.returnValue(of({ data: [], cursor: null, hasMore: false }));
    mockSyncRepo.getDataIds.and.returnValue(Promise.resolve({ data: [], cursor: null, hasMore: false }));

    TestBed.configureTestingModule({
      providers: [
        SyncService,
        { provide: SyncRepository, useValue: mockSyncRepo },
        { provide: FailedSyncBatchRepository, useValue: mockFailedBatchRepo },
        { provide: KeyPackageService, useValue: jasmine.createSpyObj('KeyPackageService', ['ensureKeyPackagePool']) },
        { provide: ConversationsService, useValue: mockConvSvc },
        { provide: MessageCacheService, useValue: mockMessageCacheSvc },
        { provide: MlsCoordinatorService, useValue: mockCoordinatorSvc },
        { provide: SecureLocalStorageService, useValue: mockSecureStorage },
      ],
    });

    service = TestBed.inject(SyncService);
    backupRegistry = TestBed.inject(MlsBackupRegistry);
    // Sets this.userDid without going through the slow-path's setupRequired$/
    // pinRequired$ branching, which isn't what's under test here.
    await service.initialize(USER_DID, DEVICE_ID);
  });

  afterEach(() => {
    service.stopFlushTimer();
  });

  describe('verifyPin', () => {
    it('resolves true for the correct PIN', async () => {
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));

      expect(await service.verifyPin(PIN)).toBe(true);
    });

    it('resolves false for an incorrect PIN, without throwing', async () => {
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));

      expect(await service.verifyPin('000000')).toBe(false);
    });
  });

  describe('rotateMbk', () => {
    it('throws and never calls the backend rotate endpoint when the PIN is wrong', async () => {
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));

      await expectAsync(service.rotateMbk('000000')).toBeRejectedWithError('Incorrect PIN');
      expect(mockSyncRepo.rotateMbk).not.toHaveBeenCalled();
    });

    it('adopts the new MBK locally under the new generation and triggers a rebuild', async () => {
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));
      mockSyncRepo.rotateMbk.and.returnValue(Promise.resolve({ keyGeneration: 2 }));
      mockSecureStorage.storeMbk.and.returnValue(Promise.resolve());
      const startRebuildSpy = spyOn(service, 'startRebuild');

      const result = await service.rotateMbk(PIN);

      expect(mockSyncRepo.rotateMbk).toHaveBeenCalledTimes(1);
      expect(mockSecureStorage.storeMbk).toHaveBeenCalledWith(USER_DID, jasmine.any(Uint8Array), 2);
      expect(startRebuildSpy).toHaveBeenCalledTimes(1);
      expect(service.isMbkAvailable()).toBe(true);
      expect(typeof result.recoveryKey).toBe('string');
      expect(result.recoveryKey.length).toBeGreaterThan(0);
    });

    it('generates a different Recovery Key on each call (never reuses the previous one)', async () => {
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));
      mockSyncRepo.rotateMbk.and.returnValue(Promise.resolve({ keyGeneration: 2 }));
      mockSecureStorage.storeMbk.and.returnValue(Promise.resolve());
      spyOn(service, 'startRebuild');

      const first  = await service.rotateMbk(PIN);
      const second = await service.rotateMbk(PIN);

      expect(first.recoveryKey).not.toBe(second.recoveryKey);
    });
  });

  describe('handleRemoteRotation', () => {
    it('is a no-op when the remote generation is not newer (e.g. the acting device echoing its own rotation)', () => {
      service.handleRemoteRotation(1); // local keyGeneration defaults to 1

      expect(mockSecureStorage.clearMbk).not.toHaveBeenCalled();
    });

    it('clears the local MBK when the remote generation is newer', async () => {
      // Give the service a real MBK first, via the legitimate rotateMbk() path.
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));
      mockSyncRepo.rotateMbk.and.returnValue(Promise.resolve({ keyGeneration: 2 }));
      mockSecureStorage.storeMbk.and.returnValue(Promise.resolve());
      spyOn(service, 'startRebuild');
      await service.rotateMbk(PIN);
      expect(service.isMbkAvailable()).toBe(true);

      service.handleRemoteRotation(3);

      expect(mockSecureStorage.clearMbk).toHaveBeenCalledWith(USER_DID);
      expect(service.isMbkAvailable()).toBe(false);
    });
  });

  describe('initialize() background freshness check (fast path)', () => {
    it('clears a stale local MBK detected against the backend generation', async () => {
      mockSecureStorage.hasMbk.and.returnValue(Promise.resolve(true));
      mockSecureStorage.loadMbk.and.returnValue(Promise.resolve({ bytes: new Uint8Array(32), keyGeneration: 1 }));
      mockSyncRepo.getSettings.and.returnValue(Promise.resolve({ ...defaultSettings, keyGeneration: 2 }));

      await service.initialize(USER_DID, DEVICE_ID);
      // checkMbkFreshness() is fire-and-forget -- let it settle.
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockSecureStorage.clearMbk).toHaveBeenCalledWith(USER_DID);
    });

    it('does nothing when the local generation already matches the backend', async () => {
      mockSecureStorage.hasMbk.and.returnValue(Promise.resolve(true));
      mockSecureStorage.loadMbk.and.returnValue(Promise.resolve({ bytes: new Uint8Array(32), keyGeneration: 2 }));
      mockSyncRepo.getSettings.and.returnValue(Promise.resolve({ ...defaultSettings, keyGeneration: 2 }));

      await service.initialize(USER_DID, DEVICE_ID);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockSecureStorage.clearMbk).not.toHaveBeenCalled();
    });

    it('does not block the fast path on the freshness check (returns before it resolves)', async () => {
      // getSettings never resolves within this test -- if initialize() awaited
      // it, this test would hang/time out instead of completing quickly.
      mockSecureStorage.hasMbk.and.returnValue(Promise.resolve(true));
      mockSecureStorage.loadMbk.and.returnValue(Promise.resolve({ bytes: new Uint8Array(32), keyGeneration: 1 }));
      mockSyncRepo.getSettings.and.returnValue(new Promise(() => {}));

      await service.initialize(USER_DID, DEVICE_ID);

      expect(service.isMbkAvailable()).toBe(true);
    });
  });

  describe('changePin() regression — must never touch keyGeneration or call secureStorage.storeMbk', () => {
    it('only re-wraps the existing MBK (putMbk), never rotates it', async () => {
      // Give the service a real MBK first.
      mockSyncRepo.getMbk.and.returnValue(Promise.resolve(realMbkBlob));
      mockSyncRepo.rotateMbk.and.returnValue(Promise.resolve({ keyGeneration: 2 }));
      mockSecureStorage.storeMbk.and.returnValue(Promise.resolve());
      spyOn(service, 'startRebuild');
      await service.rotateMbk(PIN);
      mockSecureStorage.storeMbk.calls.reset();

      mockSecureStorage.loadMbk.and.returnValue(Promise.resolve({ bytes: new Uint8Array(32), keyGeneration: 2 }));
      mockSyncRepo.putMbk.and.returnValue(Promise.resolve(undefined));

      await service.changePin('999999');

      expect(mockSyncRepo.putMbk).toHaveBeenCalledTimes(1);
      expect(mockSecureStorage.storeMbk).not.toHaveBeenCalled();
      expect(mockSyncRepo.rotateMbk).toHaveBeenCalledTimes(1); // only the earlier rotateMbk() call, not from changePin
    });
  });
});
