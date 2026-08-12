import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { MlsCoordinatorService } from './mls-coordinator.service';
import { ConversationMlsState } from './mls-coordinator.types';
import { MlsService } from '../mls.service';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { ConversationsService } from '../../conversation/conversations.service';
import { PendingDecryptRepository } from '../repositories/pending-decrypt.repository';
import { MlsWatchdogService } from '../watchdog/mls-watchdog.service';
import type { UserProfile } from '../../auth/auth.types';
import type { DeviceInfo } from '../../device/device.types';

// Regression coverage for AUDIT_08's P0 finding: MlsCoordinatorService.injectRestoredGroupStates()
// (mls-coordinator.service.ts:829-859) used to be able to force a conversation
// to READY via TRANSITION_REASON_RESTORE (state-transition-guard.ts:46) while
// a real processWelcome()/ensureGroupReady() was still in flight for that same
// conversation, because injectRestoredGroupStates() never consulted
// InitializationBarrier before forcing the transition.
//
// Fix (Solution 1, mls-coordinator.service.ts:injectRestoredGroupStates):
// candidates for a conversation with an active InitializationBarrier
// (this.barrier.isInitializing(convId)) are filtered out BEFORE being handed
// to MlsService.injectRestoredGroupStates() at all, with a second check
// immediately before each transitionState(..., READY, RESTORE) call as
// defense-in-depth against a barrier registered during the intervening await.
// No new lock/mutex was introduced; no other file was changed.
//
// This spec does NOT modify any other production file. It uses manually
// controlled deferred promises in place of MlsService's real network/crypto
// calls, so the interleaving between processWelcome()'s join and a concurrent
// restore is deterministic instead of guessed.
describe('MlsCoordinatorService — restore vs. Welcome race (AUDIT_08 P0 regression)', () => {
  let service: MlsCoordinatorService;
  let mockMlsSvc: jasmine.SpyObj<MlsService>;

  const mockUser: UserProfile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatarUrl: null };
  const mockDevice: DeviceInfo = { id: 'device-1', name: 'Web Client', platform: 'web' };

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

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
      'injectRestoredGroupStates',
      'encryptMessage',
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
      ]
    });

    service = TestBed.inject(MlsCoordinatorService);
  });

  it('Scenario A (fixed): a concurrent restore for a conversation with an in-flight processWelcome() must NOT reach READY, and must not even be handed to MlsService', fakeAsync(() => {
    const convId = 'conv-race-a';

    // conv-race-a has no local group state yet -> getOrDeriveState() derives EMPTY.
    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));

    // The real Welcome join (T4/T8 in AUDIT_08's timeline) never resolves during
    // this test until we explicitly release it below -- standing in for
    // joinGroup()'s real HPKE crypto work, which runs outside the storage lock
    // and can take real wall-clock time.
    const welcomeJoin = deferred<void>();
    mockMlsSvc.processWelcomeForConversation.and.returnValue(welcomeJoin.promise);

    // T0-T4: processWelcome() starts, registers the InitializationBarrier,
    // transitions EMPTY -> JOINING, then suspends on the still-pending join.
    let processWelcomeSettled = false;
    service
      .processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice)
      .then(() => { processWelcomeSettled = true; });

    tick(); // let getOrDeriveState()'s await + the synchronous register/transitionState run

    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Joining);
    expect(processWelcomeSettled).toBe(false); // still stuck on the unresolved join

    // T9+: a concurrent restore (as would be triggered by decryptMessage's own
    // healing branch, mls-coordinator.service.ts:585-593) lands for the SAME
    // conversation while the join above is still in flight.
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([convId]));

    let restoreSettled = false;
    service.injectRestoredGroupStates({ [convId]: 'restored-group-state-b64' }, mockUser, mockDevice)
      .then(() => { restoreSettled = true; });

    tick();

    expect(restoreSettled).toBe(true);

    // THE FIX, verified: the busy conversation is filtered out BEFORE ever
    // being handed to MlsService.injectRestoredGroupStates() -- proving
    // nothing stale could even be written to storage for it, not just that
    // the coordinator's own label was withheld.
    expect(mockMlsSvc.injectRestoredGroupStates).not.toHaveBeenCalled();

    // No premature READY: the label stays JOINING, matching the real
    // in-flight operation, not the restore's candidate.
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Joining);
    expect(service.isConversationReady(convId)).toBe(false);
    expect(service.canEncrypt(convId)).toBe(false);
    expect(processWelcomeSettled).toBe(false);

    // The real join now finishes -- READY is reached through the NORMAL,
    // fully-validated JOINING -> READY transition (transitionState() with no
    // `reason`, mls-coordinator.service.ts:248), not through the RESTORE bypass.
    welcomeJoin.resolve();
    tick();

    expect(processWelcomeSettled).toBe(true);
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
  }));

  it('Scenario A, retried: the deferred restore candidate is not lost -- a later retry (once the barrier is released) succeeds normally', fakeAsync(() => {
    const convId = 'conv-race-a-retry';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    const welcomeJoin = deferred<void>();
    mockMlsSvc.processWelcomeForConversation.and.returnValue(welcomeJoin.promise);

    service.processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice).then(() => {});
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Joining);

    // First restore attempt while busy: deferred, nothing injected.
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([convId]));
    service.injectRestoredGroupStates({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    tick();
    expect(mockMlsSvc.injectRestoredGroupStates).not.toHaveBeenCalled();

    // Real join finishes normally.
    welcomeJoin.resolve();
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    // A later restore sweep retries the same candidate: MlsService's own
    // "never overwrite an existing groupStates[convId]" check (unaffected by
    // this fix, mls.service.ts:469) is what actually rejects it now --
    // simulated here by the mock returning no injected ids for this convId.
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([]));
    service.injectRestoredGroupStates({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith(
      { [convId]: 'stale-candidate' }, mockUser, mockDevice,
    );
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
  }));

  it('Scenario B: a restore that completes before any Welcome has started is not itself a race, and the later Welcome is processed idempotently', fakeAsync(() => {
    const convId = 'conv-race-b';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([convId]));

    // Restore lands first, with no Welcome/init in flight at all for this convId.
    let restoreSettled = false;
    service.injectRestoredGroupStates({ [convId]: 'restored-group-state-b64' }, mockUser, mockDevice)
      .then(() => { restoreSettled = true; });

    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith(
      { [convId]: 'restored-group-state-b64' }, mockUser, mockDevice,
    );
    expect(restoreSettled).toBe(true);
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    // The real Welcome arrives afterwards. processWelcome() (coordinator,
    // mls-coordinator.service.ts:216-224) sees the conversation already
    // READY and takes the idempotent branch: it re-invokes
    // processWelcomeForConversation() directly without transitioning through
    // JOINING again, and must not throw.
    mockMlsSvc.processWelcomeForConversation.and.returnValue(Promise.resolve());

    let processWelcomeSettled = false;
    let processWelcomeThrew: unknown;
    service.processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice)
      .then(() => { processWelcomeSettled = true; })
      .catch(err => { processWelcomeThrew = err; });

    tick();

    expect(processWelcomeThrew).toBeUndefined();
    expect(processWelcomeSettled).toBe(true);
    expect(mockMlsSvc.processWelcomeForConversation).toHaveBeenCalledWith(
      null, 'welcome-b64', convId, mockUser, mockDevice,
    );
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
  }));

  it('Case 5 (Welcome then restore): once a real Welcome has completed and released the barrier, a later restore for the same conversation does not corrupt its READY state', fakeAsync(() => {
    const convId = 'conv-welcome-then-restore';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    mockMlsSvc.processWelcomeForConversation.and.returnValue(Promise.resolve());

    service.processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice);
    tick();

    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    // A restore lands afterwards. MlsService.injectRestoredGroupStates()'s own
    // "never overwrite" check (mls.service.ts:469, unaffected by this fix)
    // would refuse the candidate since groupStates[convId] is already
    // populated by the real join -- simulated by the mock returning no
    // injected ids. The barrier is no longer active at this point either
    // (released in processWelcome's finally), so this call is not itself
    // filtered by the fix -- it reaches MlsService and is correctly refused there.
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([]));

    service.injectRestoredGroupStates({ [convId]: 'late-stale-candidate' }, mockUser, mockDevice);
    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith(
      { [convId]: 'late-stale-candidate' }, mockUser, mockDevice,
    );
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
  }));

  it('Case 12 (multiple conversations, one busy): a busy conversation in the same restore batch does not block an unrelated free conversation from becoming READY', fakeAsync(() => {
    const busyConvId = 'conv-busy';
    const freeConvId = 'conv-free';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    const welcomeJoin = deferred<void>();
    mockMlsSvc.processWelcomeForConversation.and.returnValue(welcomeJoin.promise);

    service.processWelcome(null, 'welcome-b64', busyConvId, mockUser, mockDevice);
    tick();
    expect(service.getConversationState(busyConvId)).toBe(ConversationMlsState.Joining);

    // A single restore batch covers both conversations at once (e.g. a full
    // MBK cloud restore returning multiple conversations' group states).
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([freeConvId]));

    service.injectRestoredGroupStates(
      { [busyConvId]: 'stale-candidate', [freeConvId]: 'valid-candidate' },
      mockUser, mockDevice,
    );
    tick();

    // Only the free conversation is handed to MlsService -- the busy one is
    // filtered out of the batch before the call, not merely skipped after.
    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith(
      { [freeConvId]: 'valid-candidate' }, mockUser, mockDevice,
    );
    expect(service.getConversationState(freeConvId)).toBe(ConversationMlsState.Ready);
    expect(service.getConversationState(busyConvId)).toBe(ConversationMlsState.Joining);

    welcomeJoin.resolve();
    tick();
    expect(service.getConversationState(busyConvId)).toBe(ConversationMlsState.Ready);
  }));

  it('Cases 9/10 (no premature state exposed to encryptMessage/decryptMessage): storage is never handed a stale candidate for a busy conversation, so there is nothing stale for either to read', fakeAsync(() => {
    const convId = 'conv-encrypt-guard';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    const welcomeJoin = deferred<void>();
    mockMlsSvc.processWelcomeForConversation.and.returnValue(welcomeJoin.promise);

    service.processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice);
    tick();

    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([convId]));
    service.injectRestoredGroupStates({ [convId]: 'restored-group-state-b64' }, mockUser, mockDevice);
    tick();

    // encryptMessage() itself is unmodified and still has no barrier gate --
    // the guarantee comes from upstream: MlsService.encryptMessage (real
    // implementation) requires state.groupStates[convId] to exist, and this
    // fix guarantees the restore never wrote one for a busy conversation.
    expect(mockMlsSvc.injectRestoredGroupStates).not.toHaveBeenCalled();
    expect(service.canEncrypt(convId)).toBe(false);
    expect(service.canDecrypt(convId)).toBe(true); // JOINING: not FAILED, decrypt attempts queue via the barrier instead

    welcomeJoin.resolve();
    tick();
    expect(service.canEncrypt(convId)).toBe(true);
  }));

  // ── Section 4 (D-G) of the multi-device validation audit ──────────────────
  // Four additional orderings requested explicitly: restore concurrent with
  // joinGroup(), with processWelcome(), with decryptMessage(), and with
  // encryptMessage(). D and E are written as ONE test, not two near-duplicates:
  // at the coordinator level (the boundary these mocks operate at),
  // "during joinGroup()" and "during processWelcome()" are the SAME
  // observable window — joinGroup() is a private crypto step fully contained
  // inside MlsService.processWelcomeForConversation(), which is exactly what
  // mockMlsSvc.processWelcomeForConversation's deferred promise stands in
  // for above (Scenario A). Claiming to test them separately by mocking the
  // same boundary twice would be a duplicate assertion dressed up as two
  // scenarios, not a real distinction — this comment documents that decision
  // rather than manufacturing a redundant test.
  it('Cases D/E (restore during joinGroup()/processWelcome(), same coordinator-level window): identical to Scenario A -- filtered by isInitializing(), never READY prematurely', fakeAsync(() => {
    const convId = 'conv-d-e';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(false));
    const welcomeJoin = deferred<void>();
    mockMlsSvc.processWelcomeForConversation.and.returnValue(welcomeJoin.promise);

    service.processWelcome(null, 'welcome-b64', convId, mockUser, mockDevice);
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Joining); // joinGroup() is in flight here

    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([convId]));
    service.injectRestoredGroupStates({ [convId]: 'restored-group-state-b64' }, mockUser, mockDevice);
    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).not.toHaveBeenCalled();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Joining);

    welcomeJoin.resolve();
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);
  }));

  it('Case F (restore concurrent with an in-flight decryptMessage() on an ALREADY-READY conversation): safe, but via the pre-existing "never overwrite" check, not via this fix', fakeAsync(() => {
    const convId = 'conv-f-decrypt';

    // Conversation is already READY (derived from existing local group
    // state) -- no barrier is ever registered for it, so isInitializing()
    // is false throughout. This case is deliberately NOT protected by this
    // fix (injectRestoredGroupStates's filter only ever excludes a convId
    // while Joining/Initializing) -- it relies entirely on
    // MlsService.injectRestoredGroupStates's OWN pre-existing guard
    // (mls.service.ts:469, "if (state.groupStates[convId]) continue"),
    // unrelated to InitializationBarrier. Asserted here to make that
    // boundary explicit rather than assumed.
    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
    // getOrDeriveState() is lazy and NOT invoked by decryptMessage() itself --
    // force the derivation via the public API first (mirrors how a real
    // caller would already have observed READY, e.g. via isConversationReady(),
    // before ever attempting a decrypt), otherwise getConversationState()
    // would still read the Map's default (EMPTY) throughout this test.
    service.canProvision(convId, mockUser, mockDevice);
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    const decryptInFlight = deferred<string>();
    mockMlsSvc.decryptMessage.and.returnValue(decryptInFlight.promise);

    let decryptSettled = false;
    service.decryptMessage(convId, 'msg-1', mockUser.did, mockDevice.id, false, Date.now(), 'ciphertext', mockUser, mockDevice)
      .then(() => { decryptSettled = true; });
    tick();
    expect(decryptSettled).toBe(false); // decrypt genuinely in flight

    // A concurrent restore for the SAME (already-READY) conversation is not
    // filtered by isInitializing() -- it reaches MlsService, which must
    // refuse it on its own (simulated here: the mock returns no injected
    // ids, standing in for that real "never overwrite" refusal).
    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([]));
    service.injectRestoredGroupStates({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready); // never disturbed

    decryptInFlight.resolve('plaintext');
    tick();
    expect(decryptSettled).toBe(true);
  }));

  it('Case G (restore concurrent with an in-flight encryptMessage() on an ALREADY-READY conversation): same boundary as Case F', fakeAsync(() => {
    const convId = 'conv-g-encrypt';

    mockMlsSvc.hasGroupState.and.returnValue(Promise.resolve(true));
    service.canProvision(convId, mockUser, mockDevice);
    tick();
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    const encryptInFlight = deferred<string>();
    mockMlsSvc.encryptMessage.and.returnValue(encryptInFlight.promise);

    let encryptSettled = false;
    service.encryptMessage(convId, 'plaintext', mockUser, mockDevice).then(() => { encryptSettled = true; });
    tick();
    expect(encryptSettled).toBe(false);

    mockMlsSvc.injectRestoredGroupStates.and.returnValue(Promise.resolve([]));
    service.injectRestoredGroupStates({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    tick();

    expect(mockMlsSvc.injectRestoredGroupStates).toHaveBeenCalledWith({ [convId]: 'stale-candidate' }, mockUser, mockDevice);
    expect(service.getConversationState(convId)).toBe(ConversationMlsState.Ready);

    encryptInFlight.resolve('ciphertext');
    tick();
    expect(encryptSettled).toBe(true);
  }));
});
