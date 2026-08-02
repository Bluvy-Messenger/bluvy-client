import { TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { MlsCoordinatorService } from './mls-coordinator.service';
import { ConversationMlsState } from './mls-coordinator.types';
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

  const mockUser: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const mockDevice: DeviceInfo = { id: 'device-1', name: 'Web Client', platform: 'web' };

  beforeEach(() => {
    mockMlsSvc = jasmine.createSpyObj<MlsService>('MlsService', [
      'decryptMessage',
      'hasGroupState',
      'processIncomingCommit',
      'catchUpMissedCommits',
      'ensureGroupReady',
      'processWelcomeForConversation',
      'fetchAndProcessPendingWelcome',
      'clearConversationGroup',
    ]);
    mockMessageCacheSvc = jasmine.createSpyObj<MessageCacheService>('MessageCacheService', ['store', 'exists']);
    mockPendingRepo = jasmine.createSpyObj<PendingDecryptRepository>('PendingDecryptRepository', ['enqueue', 'remove', 'markAttempt', 'getAll']);
    mockWatchdog = jasmine.createSpyObj<MlsWatchdogService>('MlsWatchdogService', ['watch', 'unwatch']);

    // Sane defaults so paths not under test (recovery timers, replay) don't blow up.
    mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve(false));
    mockMlsSvc.clearConversationGroup.and.returnValue(Promise.resolve());
    mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(0));
    mockPendingRepo.getAll.and.returnValue(Promise.resolve([]));
    mockMessageCacheSvc.exists.and.returnValue(Promise.resolve(false));

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

  // ── trackCommitOutcome / FAILED safety net ────────────────────────────────
  // Regression coverage for the commit-race fork this whole session was about:
  // a device stuck applying bad/forked commits must eventually be marked
  // FAILED (surfacing the "reestablish encryption" button) instead of failing
  // silently forever.
  describe('trackCommitOutcome (via processIncomingCommit / catchUpMissedCommits)', () => {
    beforeEach(() => {
      // READY from a cold start: hasGroupState (used by getOrDeriveState) says yes.
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
    });

    it('marks the conversation FAILED and emits conversationFailed$ after 3 consecutive commit failures', fakeAsync(() => {
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));

      let failedEvent: { conversationId: string } | undefined;
      service.conversationFailed$.subscribe(evt => { failedEvent = evt; });

      // 1st and 2nd failures: below threshold, state returns to READY each time.
      service.processIncomingCommit('conv-x', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-x')).toBe(ConversationMlsState.Ready);
      expect(failedEvent).toBeUndefined();

      service.processIncomingCommit('conv-x', 'commit-2', 2, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-x')).toBe(ConversationMlsState.Ready);
      expect(failedEvent).toBeUndefined();

      // 3rd consecutive failure: crosses MAX_COMMIT_FAILURES (3) -> FAILED.
      service.processIncomingCommit('conv-x', 'commit-3', 3, mockUser, mockDevice).catch(() => {});
      tick();

      expect(service.getConversationState('conv-x')).toBe(ConversationMlsState.Failed);
      expect(failedEvent).toEqual({ conversationId: 'conv-x' });

      // scheduleFailedRecovery queued a timer (5s backoff) — drain it so
      // fakeAsync doesn't complain about a pending timer at teardown.
      flush();
    }));

    it('resets the failure counter on a successful commit, so 2 failures after a success do not trip FAILED', fakeAsync(() => {
      let failedEvent: { conversationId: string } | undefined;
      service.conversationFailed$.subscribe(evt => { failedEvent = evt; });

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      service.processIncomingCommit('conv-y', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-y')).toBe(ConversationMlsState.Ready);

      // A success in between must reset the consecutive-failure count to 0.
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.resolve());
      service.processIncomingCommit('conv-y', 'commit-2', 2, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-y')).toBe(ConversationMlsState.Ready);

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      service.processIncomingCommit('conv-y', 'commit-3', 3, mockUser, mockDevice).catch(() => {});
      tick();
      service.processIncomingCommit('conv-y', 'commit-4', 4, mockUser, mockDevice).catch(() => {});
      tick();

      // Only 2 consecutive failures since the reset — must NOT be FAILED yet.
      expect(service.getConversationState('conv-y')).toBe(ConversationMlsState.Ready);
      expect(failedEvent).toBeUndefined();
    }));

    it('shares the failure counter between processIncomingCommit and catchUpMissedCommits', fakeAsync(() => {
      let failedEvent: { conversationId: string } | undefined;
      service.conversationFailed$.subscribe(evt => { failedEvent = evt; });

      // Rejections are assigned immediately before each call (rather than
      // batched upfront) so no rejected promise sits unattached across a
      // tick() — that would trip the browser's unhandled-rejection detector.
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      service.processIncomingCommit('conv-z', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();

      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      service.catchUpMissedCommits('conv-z', mockUser, mockDevice).catch(() => {});
      tick();

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      service.processIncomingCommit('conv-z', 'commit-2', 2, mockUser, mockDevice).catch(() => {});
      tick();

      // 3 consecutive failures across BOTH entry points -> FAILED.
      expect(service.getConversationState('conv-z')).toBe(ConversationMlsState.Failed);
      expect(failedEvent).toEqual({ conversationId: 'conv-z' });

      flush();
    }));

    it('derives wasReady via getOrDeriveState on a cold start instead of silently skipping the ApplyingCommit transition', fakeAsync(() => {
      // Nothing has touched 'conv-cold' yet — the internal states map has no
      // entry for it. Before the fix, wasReady was read from the raw map
      // (always undefined on cold start), so a failing commit here would
      // never count towards the failure threshold.
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));

      service.processIncomingCommit('conv-cold', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();

      // hasGroupState() must have been consulted to derive the initial state.
      expect(mockMlsSvc.hasGroupState).toHaveBeenCalledWith('conv-cold', mockUser, mockDevice);
      // And the watchdog must have observed the READY -> APPLYING_COMMIT -> READY
      // dance, proving wasReady was correctly derived as true (not skipped).
      expect(mockWatchdog.watch).toHaveBeenCalledWith('conv-cold', ConversationMlsState.ApplyingCommit);
      expect(service.getConversationState('conv-cold')).toBe(ConversationMlsState.Ready);
    }));
  });

  // ── FAILED -> EMPTY reset guard ────────────────────────────────────────────
  // Regression test for the bug that blocked resending messages: ensureGroupReady
  // and processWelcome used to try to transition directly out of FAILED into
  // INITIALIZING/JOINING, which MlsStateTransitionGuard forbids (only
  // FAILED -> EMPTY is allowed), throwing MlsAssertionError instead of retrying.
  describe('FAILED -> EMPTY reset guard', () => {
    async function driveToFailed(convId: string): Promise<void> {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      for (let i = 0; i < 3; i++) {
        await service.processIncomingCommit(convId, `commit-${i}`, i, mockUser, mockDevice).catch(() => {});
      }
    }

    it('ensureGroupReady resets FAILED -> EMPTY before proceeding to INITIALIZING, instead of throwing', fakeAsync(() => {
      driveToFailed('conv-fail-1');
      tick();
      expect(service.getConversationState('conv-fail-1')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.ensureGroupReady.and.returnValue(Promise.resolve());

      let thrown: unknown;
      service.ensureGroupReady('conv-fail-1', 'did:plc:bob', mockUser, mockDevice).catch(err => { thrown = err; });
      tick();

      expect(thrown).toBeUndefined();
      expect(service.getConversationState('conv-fail-1')).toBe(ConversationMlsState.Ready);

      flush();
    }));

    it('processWelcome resets FAILED -> EMPTY before proceeding to JOINING, instead of throwing', fakeAsync(() => {
      driveToFailed('conv-fail-2');
      tick();
      expect(service.getConversationState('conv-fail-2')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.processWelcomeForConversation.and.returnValue(Promise.resolve());

      let thrown: unknown;
      service.processWelcome('welcome-1', 'welcome-b64', 'conv-fail-2', mockUser, mockDevice).catch(err => { thrown = err; });
      tick();

      expect(thrown).toBeUndefined();
      expect(service.getConversationState('conv-fail-2')).toBe(ConversationMlsState.Ready);

      flush();
    }));
  });

  // ── Gap A: replay pending decrypts after a successful catch-up batch ─────
  describe('catchUpMissedCommits replay (Gap A)', () => {
    const pendingEntry = {
      messageId:      'msg-pending-1',
      conversationId: 'conv-a',
      ciphertext:     'cipher-b64',
      senderDid:      'did:plc:bob',
      senderDeviceId: 'device-bob',
      isMine:         false,
      createdAt:      Date.now(),
      enqueuedAt:     Date.now(),
      attempts:       0,
      lastAttemptAt:  null,
    };

    it('replays a pending message after a successful catch-up on a conversation with group state', fakeAsync(() => {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(2));
      mockPendingRepo.getAll.and.returnValue(Promise.resolve([pendingEntry]));
      mockMlsSvc.decryptMessage.and.returnValue(Promise.resolve('plaintext'));

      service.catchUpMissedCommits('conv-a', mockUser, mockDevice).catch(() => {});
      tick();

      expect(mockPendingRepo.getAll).toHaveBeenCalledWith('conv-a');
      expect(mockMessageCacheSvc.store).toHaveBeenCalled();
      expect(mockPendingRepo.remove).toHaveBeenCalledWith('msg-pending-1');
    }));

    it('does not burn the pending-entry retry budget when the device has no group state', fakeAsync(() => {
      // hasGroupState false -> getOrDeriveState derives EMPTY -> isConversationReady() false.
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(0));

      service.catchUpMissedCommits('conv-b', mockUser, mockDevice).catch(() => {});
      tick();

      expect(mockPendingRepo.getAll).not.toHaveBeenCalled();
    }));

    it('does not replay when the catch-up attempt itself fails', fakeAsync(() => {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.reject(new Error('network error')));

      service.catchUpMissedCommits('conv-c', mockUser, mockDevice).catch(() => {});
      tick();

      expect(mockPendingRepo.getAll).not.toHaveBeenCalled();
    }));
  });

  // ── C1 regression + Gap B: recoverFromFailed must not destroy a state it ──
  // just healed, and must try a non-destructive catch-up before clearing.
  describe('recoverFromFailed (catch-up-before-clear, C1 regression)', () => {
    async function driveToFailed(convId: string): Promise<void> {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('EpochTooOld')));
      for (let i = 0; i < 3; i++) {
        await service.processIncomingCommit(convId, `commit-${i}`, i, mockUser, mockDevice).catch(() => {});
      }
    }

    it('C1 regression: a genuinely successful Welcome heal is not immediately destroyed on the next attempt', fakeAsync(() => {
      driveToFailed('conv-heal-welcome');
      tick();
      expect(service.getConversationState('conv-heal-welcome')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve(true));

      tick(5_000); // fires scheduleFailedRecovery's first attempt -> recoverFromFailed
      tick();      // drains the awaits inside recoverFromFailed

      expect(service.getConversationState('conv-heal-welcome')).toBe(ConversationMlsState.Ready);
      expect(mockMlsSvc.clearConversationGroup).not.toHaveBeenCalled();

      flush();
    }));

    it('Gap B heal: no pending Welcome but catch-up applies commits -> READY without destroying state', fakeAsync(() => {
      driveToFailed('conv-heal-catchup');
      tick();
      expect(service.getConversationState('conv-heal-catchup')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve(false));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(2));

      tick(5_000);
      tick();

      expect(service.getConversationState('conv-heal-catchup')).toBe(ConversationMlsState.Ready);
      expect(mockMlsSvc.clearConversationGroup).not.toHaveBeenCalled();

      flush();
    }));

    it('no welcome and no applied commits still clears the group state (unchanged behavior)', fakeAsync(() => {
      driveToFailed('conv-clear');
      tick();
      expect(service.getConversationState('conv-clear')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve(false));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(0));

      tick(5_000);
      tick();

      expect(mockMlsSvc.clearConversationGroup).toHaveBeenCalledWith('conv-clear', mockUser, mockDevice);
      expect(service.getConversationState('conv-clear')).toBe(ConversationMlsState.Failed);

      flush();
    }));

    it('a failing catch-up attempt still falls through to the destructive clear, not a retry loop', fakeAsync(() => {
      driveToFailed('conv-catchup-throws');
      tick();
      expect(service.getConversationState('conv-catchup-throws')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve(false));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.reject(new Error('fork detected')));

      tick(5_000);
      tick();

      expect(mockMlsSvc.clearConversationGroup).toHaveBeenCalledWith('conv-catchup-throws', mockUser, mockDevice);
      expect(service.getConversationState('conv-catchup-throws')).toBe(ConversationMlsState.Failed);

      flush();
    }));
  });
});
