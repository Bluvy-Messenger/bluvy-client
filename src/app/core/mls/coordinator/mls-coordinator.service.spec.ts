import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MlsCoordinatorService } from './mls-coordinator.service';
import { MlsService } from '../mls.service';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { PendingDecryptRepository } from '../repositories/pending-decrypt.repository';
import { MlsWatchdogService } from '../watchdog/mls-watchdog.service';
import type { UserProfile } from '../../auth/auth.types';
import type { DeviceInfo } from '../../device/device.types';

describe('MlsCoordinatorService', () => {
  let service: MlsCoordinatorService;
  let mockMlsSvc: jasmine.SpyObj<MlsService>;
  let mockMessageCacheSvc: jasmine.SpyObj<MessageCacheService>;
  let mockPendingRepo: jasmine.SpyObj<PendingDecryptRepository>;
  let mockWatchdog: jasmine.SpyObj<MlsWatchdogService>;

  const mockUser: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', email: 'alice@test.com' };
  const mockDevice: DeviceInfo = { id: 'device-1', name: 'Web Client', createdAt: Date.now() };

  beforeEach(() => {
    mockMlsSvc = jasmine.createSpyObj<MlsService>('MlsService', ['decryptMessage']);
    mockMessageCacheSvc = jasmine.createSpyObj<MessageCacheService>('MessageCacheService', ['store', 'get']);
    mockPendingRepo = jasmine.createSpyObj<PendingDecryptRepository>('PendingDecryptRepository', ['enqueue', 'remove', 'markAttempt']);
    mockWatchdog = jasmine.createSpyObj<MlsWatchdogService>('MlsWatchdogService', ['registerActiveConversation']);

    TestBed.configureTestingModule({
      providers: [
        MlsCoordinatorService,
        { provide: MlsService, useValue: mockMlsSvc },
        { provide: MessageCacheService, useValue: mockMessageCacheSvc },
        { provide: PendingDecryptRepository, useValue: mockPendingRepo },
        { provide: MlsWatchdogService, useValue: mockWatchdog },
      ]
    });

    service = TestBed.inject(MlsCoordinatorService);
  });

  it('should treat ValidationError: Desired gen in the past as a permanent error (undecryptable)', fakeAsync(() => {
    // Arrange: Mock the MlsService to throw "ValidationError: Desired gen in the past"
    const pastGenError = new Error('ValidationError: Desired gen in the past');
    mockMlsSvc.decryptMessage.and.returnValue(Promise.reject(pastGenError));

    let resultState: string | undefined;

    // Act: Invoke decryptMessage
    service.decryptMessage(
      'conv-123',
      'msg-abc',
      'did:plc:bob',
      'device-bob',
      false,
      Date.now(),
      'base64-ciphertext',
      mockUser,
      mockDevice
    ).then(res => {
      resultState = res.state;
    });

    tick();

    // Assert: State must be 'undecryptable' and NOT enqueued
    expect(resultState).toBe('undecryptable');
    expect(mockPendingRepo.enqueue).not.toHaveBeenCalled();
  }));

  it('should treat transient errors (like group not ready) as transient (pending_decrypt) and enqueue them', fakeAsync(() => {
    // Arrange: Mock the MlsService to throw "MLS group not ready for this conversation"
    const transientError = new Error('MLS group not ready for this conversation');
    mockMlsSvc.decryptMessage.and.returnValue(Promise.reject(transientError));
    mockPendingRepo.enqueue.and.returnValue(Promise.resolve());

    let resultState: string | undefined;

    // Act: Invoke decryptMessage
    service.decryptMessage(
      'conv-123',
      'msg-abc',
      'did:plc:bob',
      'device-bob',
      false,
      Date.now(),
      'base64-ciphertext',
      mockUser,
      mockDevice
    ).then(res => {
      resultState = res.state;
    });

    tick();

    // Assert: State must be 'pending_decrypt' and enqueued
    expect(resultState).toBe('pending_decrypt');
    expect(mockPendingRepo.enqueue).toHaveBeenCalled();
  }));
});
