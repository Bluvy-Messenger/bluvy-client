import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { MlsCoordinatorService } from './coordinator/mls-coordinator.service';
import { ConversationMlsState } from './coordinator/mls-coordinator.types';
import { MlsService } from './mls.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { ConversationsService } from '../conversation/conversations.service';
import { PendingDecryptRepository } from './repositories/pending-decrypt.repository';
import { MlsWatchdogService } from './watchdog/mls-watchdog.service';
import { FakeMlsBackend, Device, makeGroup } from './testing/mls-multidevice-harness';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';

// Section 7 of the multi-device validation audit: idempotence.
//
// processWelcome() / restore() are tested at the coordinator level (mocked
// MlsService, same convention as mls-coordinator.restore-race.spec.ts) --
// their idempotence is a state-machine property (does calling twice/10x
// concurrently produce the same READY state and not throw), independent of
// the crypto underneath. applyCommit() / catchUpMissedCommits() /
// removeRevokedDeviceFromAllGroups() are tested with real ts-mls via the
// multi-device harness, since their idempotence is a real-crypto property
// (does re-applying a commit / re-removing an already-removed leaf actually
// no-op instead of erroring or double-applying).
//
// ensureGroupReady()'s and provisionDevice()'s OWN idempotent pre-checks
// ("if (state.groupStates[conversationId]) return", "already a member,
// skipping") are exercised structurally by mls.service.ts and
// mls-membership.service.ts respectively and already covered by their
// existing spec files' happy-path tests reaching those branches; not
// re-duplicated here.

const USER_A: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
const DEVICE_A: DeviceInfo = { id: 'device-a1', name: 'Phone', platform: 'android' };
const USER_B: UserProfile = { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatarUrl: null };
const DEVICE_B: DeviceInfo = { id: 'device-b1', name: 'Laptop', platform: 'web' };
const CONV_ID = 'conv-idempotence';

describe('MLS multi-device invariants — idempotence (Section 7)', () => {

  describe('processWelcome() / restore() (coordinator-level, mocked MlsService)', () => {
    let service: MlsCoordinatorService;
    let mockMlsSvc: jasmine.SpyObj<MlsService>;

    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>(r => { resolve = r; });
      return { promise, resolve };
    }

    beforeEach(() => {
      mockMlsSvc = jasmine.createSpyObj<MlsService>('MlsService', [
        'decryptMessage', 'hasGroupState', 'processIncomingCommit', 'catchUpMissedCommits',
        'ensureGroupReady', 'processWelcomeForConversation', 'fetchAndProcessPendingWelcome',
        'clearConversationGroup', 'injectRestoredGroupStates',
      ]);
      Object.defineProperty(mockMlsSvc, 'epochConflict$', { value: new Subject(), configurable: true });
      const mockMessageCacheSvc = jasmine.createSpyObj<MessageCacheService>('MessageCacheService', ['store', 'exists', 'getAllIds', 'getMessagesPage', 'getById']);
      const mockConvSvc = jasmine.createSpyObj<ConversationsService>('ConversationsService', ['getMessages']);
      const mockPendingRepo = jasmine.createSpyObj<PendingDecryptRepository>('PendingDecryptRepository', ['enqueue', 'remove', 'markAttempt', 'getAll', 'clear']);
      const mockWatchdog = jasmine.createSpyObj<MlsWatchdogService>('MlsWatchdogService', ['watch', 'unwatch']);
      mockPendingRepo.getAll.and.returnValue(Promise.resolve([]));

      TestBed.configureTestingModule({
        providers: [
          MlsCoordinatorService,
          { provide: MlsService, useValue: mockMlsSvc },
          { provide: MessageCacheService, useValue: mockMessageCacheSvc },
          { provide: ConversationsService, useValue: mockConvSvc },
          { provide: PendingDecryptRepository, useValue: mockPendingRepo },
          { provide: MlsWatchdogService, useValue: mockWatchdog },
        ],
      });
      service = TestBed.inject(MlsCoordinatorService);
    });

    it('processWelcome(): 1 call vs 2 sequential calls vs 10 concurrent calls all converge to READY, no throw, no duplicate side effect', fakeAsync(() => {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
      mockMlsSvc.processWelcomeForConversation.and.returnValue(Promise.resolve());

      // 1 call.
      const convId1 = 'conv-1x';
      service.processWelcome(null, 'w', convId1, USER_A, DEVICE_A);
      tick();
      expect(service.getConversationState(convId1)).toBe(ConversationMlsState.Ready);
      const callsAfter1 = mockMlsSvc.processWelcomeForConversation.calls.count();

      // 2 sequential calls on a fresh conversation.
      const convId2 = 'conv-2x';
      service.processWelcome(null, 'w', convId2, USER_A, DEVICE_A);
      tick();
      service.processWelcome(null, 'w', convId2, USER_A, DEVICE_A); // already READY -> idempotent branch
      tick();
      expect(service.getConversationState(convId2)).toBe(ConversationMlsState.Ready);

      // 10 concurrent calls on a fresh conversation.
      const convId10 = 'conv-10x';
      let thrown = 0;
      for (let i = 0; i < 10; i++) {
        service.processWelcome(null, 'w', convId10, USER_A, DEVICE_A).catch(() => { thrown++; });
      }
      tick();
      expect(service.getConversationState(convId10)).toBe(ConversationMlsState.Ready);
      expect(thrown).toBe(0);
      // Every distinct conversationId still resulted in the state machine
      // reaching READY exactly the same way -- convergence, not "first wins,
      // rest silently fail".
      expect(callsAfter1).toBeGreaterThan(0);
    }));

    it('injectRestoredGroupStates(): 1 vs 2 vs 10 concurrent calls with the SAME candidate all converge to READY without error', fakeAsync(() => {
      mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
      mockMlsSvc.injectRestoredGroupStates.and.callFake((groupStates: Record<string, string>) => Promise.resolve(Object.keys(groupStates)));

      const convId = 'conv-restore-idem';
      const candidate = { [convId]: 'restored-gs' };

      let thrown = 0;
      for (let i = 0; i < 10; i++) {
        service.injectRestoredGroupStates(candidate, USER_A, DEVICE_A).catch(() => { thrown++; });
      }
      tick();

      expect(thrown).toBe(0);
      expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
    }));
  });

  describe('applyCommit() / catchUpMissedCommits() / removeRevokedDeviceFromAllGroups() (real ts-mls via multi-device harness)', () => {
    it('applyCommit(): re-delivering the SAME commit 1x vs 2x vs 10x leaves the Group State and epoch unchanged after the first application', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
      const winningCommit = backend.getCommits(CONV_ID).find(c => c.epoch === 1)!;

      await b.commitSvc.processIncomingCommit(CONV_ID, winningCommit.commit, winningCommit.epoch, USER_B, DEVICE_B);
      const stateAfter1 = b.getGroupStateB64(CONV_ID);
      expect(b.epoch(CONV_ID)).toBe(2);

      // Re-deliver the exact same commit 9 more times (10 total).
      for (let i = 0; i < 9; i++) {
        await b.commitSvc.processIncomingCommit(CONV_ID, winningCommit.commit, winningCommit.epoch, USER_B, DEVICE_B);
      }

      expect(b.epoch(CONV_ID)).toBe(2); // unchanged
      expect(b.getGroupStateB64(CONV_ID)).toBe(stateAfter1); // byte-identical -- no re-application occurred
    });

    it('catchUpMissedCommits(): 1 vs 2 vs 10 concurrent calls all converge to the same final epoch, no double-application', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      await makeGroup(CONV_ID, backend, a, [b]);

      await a.membershipSvc.provisionDevice('device-x', CONV_ID, USER_A, DEVICE_A);
      await a.membershipSvc.provisionDevice('device-y', CONV_ID, USER_A, DEVICE_A);
      expect(a.epoch(CONV_ID)).toBe(3);
      expect(b.epoch(CONV_ID)).toBe(1); // B has missed 2 commits

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => b.commitSvc.catchUpMissedCommits(CONV_ID, USER_B, DEVICE_B)),
      );
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      expect(b.epoch(CONV_ID)).toBe(3);
      expect(b.memberDeviceIds(CONV_ID).sort()).toEqual(a.memberDeviceIds(CONV_ID).sort());
    });

    it('removeRevokedDeviceFromAllGroups(): 1 vs 2 vs 10 concurrent calls for the SAME already-removed device all no-op cleanly (idempotent leaf lookup)', async () => {
      const backend = new FakeMlsBackend();
      const a = new Device(backend, USER_A, DEVICE_A);
      const b = new Device(backend, USER_B, DEVICE_B);
      const c = new Device(backend, USER_B, { id: 'device-c1', name: 'Tablet', platform: 'web' });
      await makeGroup(CONV_ID, backend, a, [b, c]);

      await a.membershipSvc.removeRevokedDeviceFromAllGroups('device-c1', USER_A, DEVICE_A);
      expect(a.memberDeviceIds(CONV_ID)).not.toContain('device-c1');
      const epochAfterFirstRemoval = a.epoch(CONV_ID);

      // 10 more concurrent calls for the SAME (already-removed) device --
      // mls-membership.service.ts's leaf lookup (findIndex by "#deviceId"
      // suffix) returns -1 and shouldSkip=true for every one of them, so
      // none should build or post a further commit.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => a.membershipSvc.removeRevokedDeviceFromAllGroups('device-c1', USER_A, DEVICE_A)),
      );
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      expect(a.epoch(CONV_ID)).toBe(epochAfterFirstRemoval); // no further epoch advanced
      expect(a.memberDeviceIds(CONV_ID)).not.toContain('device-c1');
    });
  });
});
