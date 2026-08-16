import { TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { MlsCoordinatorService } from './mls-coordinator.service';
import { ConversationMlsState } from './mls-coordinator.types';
import { MlsService } from '../mls.service';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { ConversationsService } from '../../conversation/conversations.service';
import { PendingDecryptRepository } from '../repositories/pending-decrypt.repository';
import { MlsWatchdogService } from '../watchdog/mls-watchdog.service';
import { MlsBackupRegistry } from '../mls-backup-registry.service';
import { EpochGapError } from '../errors/epoch-gap-error';
import type { UserProfile } from '../../auth/auth.types';
import type { DeviceInfo } from '../../device/device.types';

describe('MlsCoordinatorService', () => {
  let service: MlsCoordinatorService;
  let mockMlsSvc: jasmine.SpyObj<MlsService>;
  let mockMessageCacheSvc: jasmine.SpyObj<MessageCacheService>;
  let mockConvSvc: jasmine.SpyObj<ConversationsService>;
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
    mockMessageCacheSvc = jasmine.createSpyObj<MessageCacheService>('MessageCacheService', ['store', 'exists', 'getAllIds', 'getMessagesPage', 'getById']);
    mockConvSvc = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getMessages']);
    mockPendingRepo = jasmine.createSpyObj<PendingDecryptRepository>('PendingDecryptRepository', ['enqueue', 'remove', 'markAttempt', 'getAll', 'clear']);
    mockWatchdog = jasmine.createSpyObj<MlsWatchdogService>('MlsWatchdogService', ['watch', 'unwatch']);
    // epochConflict$ is a real Observable property (not a spy-able method) --
    // the constructor subscribes to it directly, same as MlsCoordinatorService's
    // own pendingDecryptQueued$ pattern seen in sync.service.spec.ts.
    Object.defineProperty(mockMlsSvc, 'epochConflict$', { value: new Subject(), configurable: true });

    // Sane defaults so paths not under test (recovery timers, replay) don't blow up.
    mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve('none'));
    mockMlsSvc.clearConversationGroup.and.returnValue(Promise.resolve());
    mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(0));
    mockPendingRepo.getAll.and.returnValue(Promise.resolve([]));
    mockMessageCacheSvc.exists.and.returnValue(Promise.resolve(false));
    mockMessageCacheSvc.getAllIds.and.returnValue(Promise.resolve(new Set<string>()));
    // recoverMissingHistoryBeforeClear (runs inside clearConversationGroup) sees an
    // empty server page by default -- nothing to recover, nothing to fail on.
    mockConvSvc.getMessages.and.returnValue(of({ data: [], cursor: null, hasMore: false }));
    mockMessageCacheSvc.getMessagesPage.and.returnValue(Promise.resolve([]));
    mockMessageCacheSvc.getById.and.returnValue(Promise.resolve(null));

    TestBed.configureTestingModule({
      providers: [
        MlsCoordinatorService,
        { provide: MlsService, useValue: mockMlsSvc },
        { provide: MessageCacheService, useValue: mockMessageCacheSvc },
        { provide: ConversationsService, useValue: mockConvSvc },
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
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));

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

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
      service.processIncomingCommit('conv-y', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-y')).toBe(ConversationMlsState.Ready);

      // A success in between must reset the consecutive-failure count to 0.
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.resolve());
      service.processIncomingCommit('conv-y', 'commit-2', 2, mockUser, mockDevice).catch(() => {});
      tick();
      expect(service.getConversationState('conv-y')).toBe(ConversationMlsState.Ready);

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
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
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
      service.processIncomingCommit('conv-z', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();

      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.reject(new Error('epoch too old')));
      service.catchUpMissedCommits('conv-z', mockUser, mockDevice).catch(() => {});
      tick();

      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
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
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));

      service.processIncomingCommit('conv-cold', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();

      // hasGroupState() must have been consulted to derive the initial state.
      expect(mockMlsSvc.hasGroupState).toHaveBeenCalledWith('conv-cold', mockUser, mockDevice);
      // And the watchdog must have observed the READY -> APPLYING_COMMIT -> READY
      // dance, proving wasReady was correctly derived as true (not skipped).
      expect(mockWatchdog.watch).toHaveBeenCalledWith('conv-cold', ConversationMlsState.ApplyingCommit);
      expect(service.getConversationState('conv-cold')).toBe(ConversationMlsState.Ready);
    }));

    // Forensic audit finding F8: a missed commit (EpochGapError) is not a
    // fork and must not count toward the failure threshold or classify as
    // permanent -- it should trigger a direct catch-up instead.
    it('catches up directly on EpochGapError instead of counting it as a commit failure, and stays READY', fakeAsync(() => {
      let failedEvent: { conversationId: string } | undefined;
      service.conversationFailed$.subscribe(evt => { failedEvent = evt; });

      const gapError = new EpochGapError('conv-gap', 2, 3);
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(gapError));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.resolve(2));

      service.processIncomingCommit('conv-gap', 'commit-3', 3, mockUser, mockDevice).catch(() => {});
      tick();

      expect(mockMlsSvc.catchUpMissedCommits).toHaveBeenCalledWith('conv-gap', mockUser, mockDevice);
      expect(service.getConversationState('conv-gap')).toBe(ConversationMlsState.Ready);
      expect(failedEvent).toBeUndefined();

      // Repeating it 3 more times must still never trip FAILED -- proves it
      // isn't merely being tolerated below MAX_COMMIT_FAILURES by coincidence.
      for (let i = 0; i < 3; i++) {
        mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(gapError));
        service.processIncomingCommit('conv-gap', `commit-${4 + i}`, 4 + i, mockUser, mockDevice).catch(() => {});
        tick();
      }
      expect(service.getConversationState('conv-gap')).toBe(ConversationMlsState.Ready);
      expect(failedEvent).toBeUndefined();
    }));

    it('falls through to normal failure handling if the catch-up after an epoch gap itself fails', fakeAsync(() => {
      const gapError = new EpochGapError('conv-gap-fail', 0, 1);
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(gapError));
      mockMlsSvc.catchUpMissedCommits.and.returnValue(Promise.reject(new Error('network down')));

      service.processIncomingCommit('conv-gap-fail', 'commit-1', 1, mockUser, mockDevice).catch(() => {});
      tick();

      // Catch-up failed too -- falls through to the ordinary counter, not an
      // immediate FAILED (the underlying error isn't recognized as permanent).
      expect(service.getConversationState('conv-gap-fail')).toBe(ConversationMlsState.Ready);
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
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
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

      mockMlsSvc.processWelcomeForConversation.and.returnValue(Promise.resolve('joined'));

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
      mockMlsSvc.processIncomingCommit.and.returnValue(Promise.reject(new Error('epoch too old')));
      for (let i = 0; i < 3; i++) {
        await service.processIncomingCommit(convId, `commit-${i}`, i, mockUser, mockDevice).catch(() => {});
      }
    }

    it('C1 regression: a genuinely successful Welcome heal is not immediately destroyed on the next attempt', fakeAsync(() => {
      driveToFailed('conv-heal-welcome');
      tick();
      expect(service.getConversationState('conv-heal-welcome')).toBe(ConversationMlsState.Failed);

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve('joined'));

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

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve('none'));
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

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve('none'));
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

      mockMlsSvc.fetchAndProcessPendingWelcome.and.returnValue(Promise.resolve('none'));
      // callFake (not returnValue) so the rejected promise is created lazily
      // when catchUpMissedCommits is actually invoked inside tick(5_000)
      // below, not eagerly right here -- an eagerly-created rejected promise
      // sitting unconsumed across that gap is flagged by zone.js as an
      // unhandled rejection even though recoverFromFailed does catch it once
      // called.
      mockMlsSvc.catchUpMissedCommits.and.callFake(() => Promise.reject(new Error('fork detected')));

      tick(5_000);
      tick();

      expect(mockMlsSvc.clearConversationGroup).toHaveBeenCalledWith('conv-catchup-throws', mockUser, mockDevice);
      expect(service.getConversationState('conv-catchup-throws')).toBe(ConversationMlsState.Failed);

      flush();
    }));
  });

  // ── Feature 1: structural recovery failures block destruction ────────────
  describe('recoverMissingHistoryBeforeClear (structural failure propagation)', () => {
    it('propagates a server pagination failure and does not destroy group state', fakeAsync(() => {
      mockConvSvc.getMessages.and.returnValue(throwError(() => new Error('network down')));

      let thrown: unknown;
      service.clearConversationGroup('conv-recover-fail', mockUser, mockDevice).catch(err => { thrown = err; });
      tick();

      expect(thrown).toBeDefined();
      expect(mockMlsSvc.clearConversationGroup).not.toHaveBeenCalled();
    }));

    it('emits historyRecoveryCompleted$ with counts and still clears after a confirmed-complete sweep', fakeAsync(() => {
      mockConvSvc.getMessages.and.returnValue(of({
        data: [{ id: 'srv-1', conversationId: 'conv-recover-ok', ciphertext: 'c1', senderDid: 'did:plc:bob', senderDeviceId: 'device-bob', createdAt: 1 }],
        cursor:  null,
        hasMore: false,
      }));
      mockMessageCacheSvc.getAllIds.and.returnValue(Promise.resolve(new Set<string>()));
      mockMlsSvc.decryptMessage.and.returnValue(Promise.resolve('plaintext'));

      let event: { conversationId: string; recovered: number; stillUndecryptable: number } | undefined;
      service.historyRecoveryCompleted$.subscribe(e => { event = e; });

      service.clearConversationGroup('conv-recover-ok', mockUser, mockDevice).catch(() => {});
      tick();

      expect(event).toEqual({ conversationId: 'conv-recover-ok', recovered: 1, stillUndecryptable: 0 });
      expect(mockMlsSvc.clearConversationGroup).toHaveBeenCalledWith('conv-recover-ok', mockUser, mockDevice);
    }));
  });

  // ── Feature 3: retroactive cloud healing once the MBK becomes available ──
  describe('retryUndecryptableViaCloudBackup', () => {
    const undecryptableMsg = {
      id: 'msg-u1', conversationId: 'conv-heal', senderDeviceId: 'device-bob', senderDid: 'did:plc:bob',
      plaintext: '', isMine: false, undecryptable: true, cacheVersion: 1, encryptionVersion: 1,
      deletedAt: null, createdAt: 1, cachedAt: 1,
    };

    it('returns 0 without touching the cache when the MBK is not available', fakeAsync(() => {
      let result: number | undefined;
      service.retryUndecryptableViaCloudBackup('conv-heal', mockUser, mockDevice).then(r => { result = r; });
      tick();

      expect(result).toBe(0);
      expect(mockMessageCacheSvc.getMessagesPage).not.toHaveBeenCalled();
    }));

    it('returns 0 without calling restore when the MBK is available but nothing is undecryptable', fakeAsync(() => {
      const restore = jasmine.createSpy('restore').and.returnValue(Promise.resolve());
      TestBed.inject(MlsBackupRegistry).setBackupService({
        backupGroupState: () => {},
        enqueue: () => {},
        isMbkAvailable: () => true,
        restore,
      });
      mockMessageCacheSvc.getMessagesPage.and.returnValue(Promise.resolve([]));

      let result: number | undefined;
      service.retryUndecryptableViaCloudBackup('conv-heal', mockUser, mockDevice).then(r => { result = r; });
      tick();

      expect(result).toBe(0);
      expect(restore).not.toHaveBeenCalled();
    }));

    it('restores from the cloud and reports how many undecryptable placeholders were healed', fakeAsync(() => {
      const restore = jasmine.createSpy('restore').and.returnValue(Promise.resolve());
      TestBed.inject(MlsBackupRegistry).setBackupService({
        backupGroupState: () => {},
        enqueue: () => {},
        isMbkAvailable: () => true,
        restore,
      });
      mockMessageCacheSvc.getMessagesPage.and.returnValue(Promise.resolve([undecryptableMsg]));
      mockMessageCacheSvc.getById.and.returnValue(Promise.resolve({ ...undecryptableMsg, plaintext: 'hi', undecryptable: false }));

      let result: number | undefined;
      service.retryUndecryptableViaCloudBackup('conv-heal', mockUser, mockDevice).then(r => { result = r; });
      tick();

      expect(restore).toHaveBeenCalled();
      expect(result).toBe(1);
    }));
  });

  // ── AUDIT ADVERSARIAL P1 fix: ensureGroupReady() concurrency ─────────────
  // A concurrent call for the SAME convId must never launch a second,
  // independent MlsService.ensureGroupReady() attempt while one is already
  // in flight -- confirmed as a real defect by a real-crypto test in
  // mls-invariants-ensuregroupready-crashrestart.spec.ts (a losing call
  // could resolve SUCCESS purely by observing the winning call's
  // not-yet-server-confirmed optimistic local write). This exercises the fix
  // at the REAL production entry point (MlsCoordinatorService.ensureGroupReady()
  // -- the only thing the rest of the app ever calls; MlsService.ensureGroupReady()
  // is never called directly outside the coordinator and tests) using
  // InitializationBarrier, with mlsSvc mocked so the timing is fully
  // controlled rather than depending on real crypto durations.
  describe('ensureGroupReady() concurrency (AUDIT ADVERSARIAL P1 fix)', () => {
    const CONV_ID = 'conv-concurrent-genesis';

    it('a second concurrent call waits for the first and adopts its SUCCESS instead of returning independently', async () => {
      let resolveFirst!: () => void;
      const firstAttempt = new Promise<void>(resolve => { resolveFirst = resolve; });
      mockMlsSvc.ensureGroupReady.and.returnValue(firstAttempt);

      const p1 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);
      const p2 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);

      expect(mockMlsSvc.ensureGroupReady).withContext('only ONE real attempt while the first is still in flight').toHaveBeenCalledTimes(1);

      let p2Settled = false;
      void p2.then(() => { p2Settled = true; });
      // Flush several microtask turns -- p2 must still be pending.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(p2Settled).withContext('p2 must not resolve while the real ensureGroupReady() call is still unconfirmed').toBeFalse();

      resolveFirst();
      await p1;
      await p2;

      expect(mockMlsSvc.ensureGroupReady).withContext('still only ONE real attempt total -- p2 adopted p1\'s result, it did not trigger its own').toHaveBeenCalledTimes(1);
      expect(service.isConversationReady(CONV_ID)).toBeTrue();
    });

    it('after the first attempt genuinely fails, a waiting concurrent caller retries for real instead of silently succeeding or inheriting the same rejection', async () => {
      let rejectFirst!: (err: unknown) => void;
      const firstAttempt = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      let callCount = 0;
      mockMlsSvc.ensureGroupReady.and.callFake(() => {
        callCount++;
        return callCount === 1 ? firstAttempt : Promise.resolve();
      });

      const p1 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);
      const p2 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);
      void p1.catch(() => {});

      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(mockMlsSvc.ensureGroupReady).toHaveBeenCalledTimes(1);

      rejectFirst(new Error('simulated genesis failure'));
      await expectAsync(p1).toBeRejected();
      await p2; // must succeed via a genuine SECOND attempt, not p1's failure and not a phantom success

      expect(mockMlsSvc.ensureGroupReady).withContext('p2 must have triggered a real second attempt after p1 genuinely failed').toHaveBeenCalledTimes(2);
      expect(service.isConversationReady(CONV_ID)).toBeTrue();
    });

    it('never issues more than one real ensureGroupReady() attempt at a time across three concurrent callers', async () => {
      let resolveFirst!: () => void;
      const firstAttempt = new Promise<void>(resolve => { resolveFirst = resolve; });
      mockMlsSvc.ensureGroupReady.and.returnValue(firstAttempt);

      const p1 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);
      const p2 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);
      const p3 = service.ensureGroupReady(CONV_ID, 'did:plc:bob', mockUser, mockDevice);

      expect(mockMlsSvc.ensureGroupReady).toHaveBeenCalledTimes(1);

      resolveFirst();
      await Promise.all([p1, p2, p3]);

      expect(mockMlsSvc.ensureGroupReady).withContext('exactly one real attempt regardless of how many callers were waiting').toHaveBeenCalledTimes(1);
      expect(service.isConversationReady(CONV_ID)).toBeTrue();
    });
  });
});
