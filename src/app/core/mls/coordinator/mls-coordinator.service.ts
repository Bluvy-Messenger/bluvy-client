import { Injectable, inject } from '@angular/core';
import { Observable, Subject }   from 'rxjs';
import { environment } from '../../../../environments/environment';
import type { UserProfile }      from '../../auth/auth.types';
import type { DeviceInfo }       from '../../device/device.types';
import { MlsService }            from '../mls.service';
import { MessageCacheService } from '../../conversation/message-cache.service';
import type { CachedMessage } from '../../conversation/conversation.types';
import { InitializationBarrier }    from '../state-machine/initialization-barrier';
import { MlsStateTransitionGuard, TRANSITION_REASON_RESTORE } from '../state-machine/state-transition-guard';
import { PendingDecryptRepository } from '../repositories/pending-decrypt.repository';
import { TransientMlsError }        from '../errors/transient-mls-error';
import { PermanentMlsError }        from '../errors/permanent-mls-error';
import { MlsWatchdogService }       from '../watchdog/mls-watchdog.service';
import { assertMls }                from '../assertions/mls-assertions';
import {
  ConversationMlsState,
  type DecryptResult,
  type ReplayResult,
  type ReplayedDecryptEvent,
} from './mls-coordinator.types';
import {
  type ConversationReadyEvent,
  type WelcomeProcessedEvent,
  type CommitAppliedEvent,
  type PendingDecryptQueuedEvent,
  type RestoreCompletedEvent,
} from './mls-coordinator.events';
import { MlsCoordinatorBase } from './mls-coordinator.base';

type BackupEnqueuerLike = {
  enqueue(item: {
    messageId:      string;
    conversationId: string;
    plaintext:      string;
    createdAt:      number;
    senderDid:      string;
  }): void;
};

// Error message fragments from ts-mls that indicate transient vs permanent failures.
const TRANSIENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/mls group not ready/i,   'GroupNotReady'],
  [/mls not initialized/i,   'GroupNotReady'],
  [/desired gen/i,           'EpochMismatch'],
] as const;

const PERMANENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid mls message/i,           'InvalidCiphertext'],
  [/no matching key package/i,       'InvalidCiphertext'],
  [/invalid welcome message/i,       'InvalidCiphertext'],
  [/failed to decode mls group/i,    'CorruptedPayload'],
  [/expected application message/i,  'WireformatMismatch'],
  [/invalid mac/i,                   'InvalidSignature'],
  [/invalid signature/i,             'InvalidSignature'],
  [/epoch too old/i,                 'EpochTooOld'],
] as const;

@Injectable({ providedIn: 'root' })
export class MlsCoordinatorService extends MlsCoordinatorBase {
  private readonly mlsSvc          = inject(MlsService);
  private readonly messageCacheSvc = inject(MessageCacheService);
  private readonly pendingRepo     = inject(PendingDecryptRepository);
  private readonly watchdog        = inject(MlsWatchdogService);

  private readonly barrier = new InitializationBarrier();

  // In-memory state per conversation.
  private readonly states = new Map<string, ConversationMlsState>();
  // Deduplicates concurrent state derivations for the same convId.
  private readonly pendingDerivations = new Map<string, Promise<ConversationMlsState>>();
  // Deduplicates concurrent decryptMessage calls for the same messageId.
  private readonly inFlightDecrypts = new Map<string, Promise<DecryptResult>>();

  private backupSvcRef: BackupEnqueuerLike | null = null;

  // Auto-recovery state for FAILED conversations (backoff: 5s, 15s, 45s).
  private readonly failedRecovery = new Map<string, { attempts: number; timerId: ReturnType<typeof setTimeout> | undefined }>();

  // ── Private Subjects ───────────────────────────────────────────────────────
  private readonly _conversationReady$$    = new Subject<ConversationReadyEvent>();
  private readonly _welcomeProcessed$$     = new Subject<WelcomeProcessedEvent>();
  private readonly _commitApplied$$        = new Subject<CommitAppliedEvent>();
  private readonly _pendingDecryptQueued$$ = new Subject<PendingDecryptQueuedEvent>();
  private readonly _pendingDecryptReplayed$$ = new Subject<ReplayedDecryptEvent>();
  private readonly _restoreCompleted$$     = new Subject<RestoreCompletedEvent>();

  // ── Public Observables (MlsCoordinatorBase contract) ──────────────────────
  override readonly conversationReady$      = this._conversationReady$$.asObservable();
  override readonly welcomeProcessed$       = this._welcomeProcessed$$.asObservable();
  override readonly commitApplied$          = this._commitApplied$$.asObservable();
  override readonly pendingDecryptQueued$   = this._pendingDecryptQueued$$.asObservable();
  override readonly pendingDecryptReplayed$ = this._pendingDecryptReplayed$$.asObservable();
  override readonly restoreCompleted$       = this._restoreCompleted$$.asObservable();

  // Called by BackupService at construction time to avoid a circular DI cycle.
  setBackupService(svc: BackupEnqueuerLike): void {
    this.backupSvcRef = svc;
  }

  // ── Session ───────────────────────────────────────────────────────────────

  override async initializeForSession(user: UserProfile, device: DeviceInfo): Promise<void> {
    assertMls(!!user?.did,    'initializeForSession: user.did required', { user });
    assertMls(!!device?.id,   'initializeForSession: device.id required', { device });
    await this.mlsSvc.initializeForSession(user, device);
    void this.pendingRepo.pruneStale();
  }

  // ── Semantic capability checks ─────────────────────────────────────────────

  override isConversationReady(convId: string): boolean {
    return this.states.get(convId) === ConversationMlsState.Ready;
  }

  override canEncrypt(convId: string): boolean {
    return this.states.get(convId) === ConversationMlsState.Ready;
  }

  override canDecrypt(convId: string): boolean {
    const state = this.states.get(convId);
    return state !== ConversationMlsState.Failed &&
           state !== undefined;
  }

  override async canProvision(convId: string, user: UserProfile, device: DeviceInfo): Promise<boolean> {
    const state = await this.getOrDeriveState(convId, user, device);
    return state === ConversationMlsState.Ready;
  }

  // ── Welcome ───────────────────────────────────────────────────────────────

  override async processWelcome(
    welcomeId:     string | null,
    welcomeBase64: string,
    convId:        string,
    user:          UserProfile,
    device:        DeviceInfo,
  ): Promise<void> {
    assertMls(!!welcomeBase64, 'processWelcome: welcomeBase64 required', { convId });
    assertMls(!!convId,        'processWelcome: convId required');

    const operationId = crypto.randomUUID();

    // If already READY (stale socket event or concurrent call), attempt idempotent processing.
    const currentState = await this.getOrDeriveState(convId, user, device);
    if (currentState === ConversationMlsState.Ready) {
      try {
        await this.mlsSvc.processWelcomeForConversation(welcomeId, welcomeBase64, convId, user, device);
      } catch (err) {
        if (!environment.production) console.warn('[MLS:coordinator] processWelcome on READY state (idempotent):', err);
      }
      return;
    }

    // Register the barrier BEFORE the first await so concurrent decryptMessage()
    // calls see it immediately and block.
    const { release } = this.barrier.register(convId);

    // Re-check after registering: a concurrent processWelcome may have finished
    // while we were awaiting getOrDeriveState above.
    if (this.isConversationReady(convId)) {
      release();
      return;
    }

    this.transitionState(convId, ConversationMlsState.Joining);

    try {
      await this.mlsSvc.processWelcomeForConversation(welcomeId, welcomeBase64, convId, user, device);
      this.transitionState(convId, ConversationMlsState.Ready);
      this._welcomeProcessed$$.next({ conversationId: convId, welcomeId, operationId });
    } catch (err) {
      this.transitionState(convId, ConversationMlsState.Failed);
      this.scheduleFailedRecovery(convId, user, device);
      throw err;
    } finally {
      release();
    }

    await this.replayPendingDecrypts(convId, user, device);
  }

  override async fetchAndProcessPendingWelcome(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<boolean> {
    return this.mlsSvc.fetchAndProcessPendingWelcome(convId, user, device);
  }

  // ── Group readiness ────────────────────────────────────────────────────────

  override async ensureGroupReady(
    convId:         string,
    participantDid: string,
    user:           UserProfile,
    device:         DeviceInfo,
    signal?:        AbortSignal,
  ): Promise<void> {
    assertMls(!!participantDid, 'ensureGroupReady: participantDid required', { convId });
    assertMls(!!convId,         'ensureGroupReady: convId required');

    if (this.isConversationReady(convId)) return;

    const { release } = this.barrier.register(convId);

    // Re-check after barrier registration — processWelcome may have completed concurrently.
    if (this.isConversationReady(convId)) {
      release();
      return;
    }

    this.transitionState(convId, ConversationMlsState.Initializing);
    try {
      await this.mlsSvc.ensureGroupReady(convId, participantDid, user, device, signal);
      this.transitionState(convId, ConversationMlsState.Ready);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.transitionState(convId, ConversationMlsState.Empty);
      } else {
        this.transitionState(convId, ConversationMlsState.Failed);
        this.scheduleFailedRecovery(convId, user, device);
      }
      throw err;
    } finally {
      release();
    }
    await this.replayPendingDecrypts(convId, user, device);
  }

  override async clearConversationGroup(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    await this.mlsSvc.clearConversationGroup(convId, user, device);
    await this.pendingRepo.clear(convId);
    this.transitionState(convId, ConversationMlsState.Empty);
  }

  override async prepareConversation(
    user:           UserProfile,
    device:         DeviceInfo,
    participantDid: string,
  ): Promise<void> {
    assertMls(!!participantDid, 'prepareConversation: participantDid required');
    await this.mlsSvc.prepareConversationInitialization(user, device, participantDid);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  // Never throws. Returns a DecryptResult with state 'plaintext', 'pending_decrypt',
  // or 'undecryptable'. The caller must write to the message cache ONLY for
  // 'plaintext' and 'undecryptable' states.
  override async decryptMessage(
    convId:         string,
    messageId:      string,
    senderDid:      string,
    senderDeviceId: string,
    isMine:         boolean,
    createdAt:      number,
    ciphertextB64:  string,
    user:           UserProfile,
    device:         DeviceInfo,
  ): Promise<DecryptResult> {
    assertMls(!!ciphertextB64, 'decryptMessage: ciphertextB64 required', { messageId, convId });
    assertMls(!!messageId,     'decryptMessage: messageId required', { convId });
    assertMls(!!convId,        'decryptMessage: convId required');

    // If the same messageId is already being decrypted, share the in-flight promise
    // instead of starting a second MLS decryption. A concurrent second attempt would
    // consume the same secretTree generation and throw CryptoError: OperationError,
    // then overwrite the correct plaintext in cache with undecryptable: true.
    const inflight = this.inFlightDecrypts.get(messageId);
    if (inflight) return inflight;

    const promise: Promise<DecryptResult> = (async () => {
      const operationId = crypto.randomUUID();

      await this.barrier.wait(convId);

      try {
        const plaintext = await this.mlsSvc.decryptMessage(convId, user, device, ciphertextB64);
        this.states.set(convId, ConversationMlsState.Ready);
        return { messageId, conversationId: convId, state: 'plaintext' as const, plaintext, operationId };
      } catch (err) {
        const classified = this.classifyError(err, convId);
        if (!environment.production) console.error('[MLS:coordinator] decryptMessage error for', messageId, '->', classified.kind, ':', err);

        if (classified instanceof TransientMlsError) {
          await this.pendingRepo.enqueue({
            messageId,
            conversationId: convId,
            ciphertext:     ciphertextB64,
            senderDid,
            senderDeviceId,
            isMine,
            createdAt,
            enqueuedAt:    Date.now(),
            attempts:      0,
            lastAttemptAt: null,
          });
          this._pendingDecryptQueued$$.next({
            conversationId: convId, messageId, errorKind: classified.kind, operationId,
          });
          return { messageId, conversationId: convId, state: 'pending_decrypt' as const, plaintext: '', errorKind: classified.kind, operationId };
        }

        return { messageId, conversationId: convId, state: 'undecryptable' as const, plaintext: '', errorKind: classified.kind, operationId };
      }
    })();

    this.inFlightDecrypts.set(messageId, promise);
    void promise.finally(() => this.inFlightDecrypts.delete(messageId));
    return promise;
  }

  override async encryptMessage(
    convId:    string,
    plaintext: string,
    user:      UserProfile,
    device:    DeviceInfo,
  ): Promise<string> {
    assertMls(!!plaintext, 'encryptMessage: plaintext required', { convId });
    assertMls(!!convId,    'encryptMessage: convId required');
    return this.mlsSvc.encryptMessage(convId, user, device, plaintext);
  }

  // ── Commits ────────────────────────────────────────────────────────────────

  override processIncomingCommit(
    convId:       string,
    commitBase64: string,
    epoch:        number,
    user:         UserProfile,
    device:       DeviceInfo,
  ): Promise<void> {
    assertMls(!!commitBase64, 'processIncomingCommit: commitBase64 required', { convId, epoch });
    assertMls(epoch >= 0,     'processIncomingCommit: epoch must be >= 0', { convId, epoch });

    const operationId = crypto.randomUUID();
    return this.mlsSvc.processIncomingCommit(convId, commitBase64, epoch, user, device)
      .then(() => {
        this._commitApplied$$.next({ conversationId: convId, epoch, operationId });
      });
  }

  override async catchUpMissedCommits(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    return this.mlsSvc.catchUpMissedCommits(convId, user, device);
  }

  // ── Provisioning ──────────────────────────────────────────────────────────

  override async provisionDevice(
    newDeviceId: string,
    convId:      string,
    user:        UserProfile,
    device:      DeviceInfo,
  ): Promise<void> {
    assertMls(!!newDeviceId, 'provisionDevice: newDeviceId required', { convId });
    return this.mlsSvc.provisionDevice(newDeviceId, convId, user, device);
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  override async injectRestoredGroupStates(
    groupStates: Record<string, string>,
    user:        UserProfile,
    device:      DeviceInfo,
  ): Promise<void> {
    assertMls(groupStates !== null && typeof groupStates === 'object',
      'injectRestoredGroupStates: groupStates must be an object');

    const operationId = crypto.randomUUID();
    await this.mlsSvc.injectRestoredGroupStates(groupStates, user, device);

    // Mark all restored conversations as READY, bypassing normal transition rules.
    for (const convId of Object.keys(groupStates)) {
      const from = this.states.get(convId) ?? ConversationMlsState.Empty;
      this.states.set(convId, ConversationMlsState.Ready);
      this.watchdog.watch(convId, ConversationMlsState.Ready);
      this._conversationReady$$.next({ conversationId: convId, from, operationId });
    }

    this._restoreCompleted$$.next({
      conversationCount: Object.keys(groupStates).length,
      operationId,
    });
  }

  // ── Replay ─────────────────────────────────────────────────────────────────

  override async replayPendingDecrypts(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<ReplayResult> {
    const operationId = crypto.randomUUID();
    const pending     = await this.pendingRepo.getAll(convId);

    if (pending.length === 0) {
      return { conversationId: convId, total: 0, succeeded: 0, permanentFailed: 0, stillPending: 0, operationId };
    }

    let succeeded = 0, permanentFailed = 0, stillPending = 0;
    const replayed: CachedMessage[] = [];

    for (const entry of pending) {
      if (await this.messageCacheSvc.exists(entry.messageId)) {
        await this.pendingRepo.remove(entry.messageId);
        continue;
      }

      try {
        const plaintext = await this.mlsSvc.decryptMessage(convId, user, device, entry.ciphertext);
        const cached    = this.buildCached(entry, plaintext, false);
        await this.messageCacheSvc.store(cached);
        await this.pendingRepo.remove(entry.messageId);
        this.backupSvcRef?.enqueue({
          messageId:      entry.messageId,
          conversationId: convId,
          plaintext,
          createdAt:      entry.createdAt,
          senderDid:      entry.senderDid,
        });
        replayed.push(cached);
        succeeded++;
      } catch (err) {
        const classified = this.classifyError(err, convId);

        // In READY state: EpochMismatch means the ratchet has advanced past this message.
        const isPermanent =
          classified instanceof PermanentMlsError ||
          classified.kind === 'EpochMismatch' ||
          entry.attempts >= 1;

        if (isPermanent) {
          const cached = this.buildCached(entry, '', true);
          await this.messageCacheSvc.store(cached);
          await this.pendingRepo.remove(entry.messageId);
          replayed.push(cached);
          permanentFailed++;
        } else {
          await this.pendingRepo.markAttempt(entry.messageId);
          stillPending++;
        }
      }
    }

    if (replayed.length > 0) {
      this._pendingDecryptReplayed$$.next({ conversationId: convId, messages: replayed });
    }

    if (!environment.production) console.log(
      `[MLS:coordinator] replayPendingDecrypts convId=${convId}`,
      `total=${pending.length} ok=${succeeded} permanent=${permanentFailed} pending=${stillPending}`,
    );

    return { conversationId: convId, total: pending.length, succeeded, permanentFailed, stillPending, operationId };
  }

  // ── Internal state (not on MlsCoordinatorBase) ────────────────────────────

  getConversationState(convId: string): ConversationMlsState {
    return this.states.get(convId) ?? ConversationMlsState.Empty;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  // Schedules an auto-recovery attempt from FAILED state (backoff: 5s, 15s, 45s).
  // Stops after 3 failed attempts. Safe to call multiple times — deduplicates by convId.
  private scheduleFailedRecovery(convId: string, user: UserProfile, device: DeviceInfo): void {
    const attempts = this.failedRecovery.get(convId)?.attempts ?? 0;
    if (attempts >= 3) return;

    const delays = [5_000, 15_000, 45_000] as const;
    const timerId = setTimeout(() => {
      void this.recoverFromFailed(convId, user, device);
    }, delays[attempts as 0 | 1 | 2]);

    this.failedRecovery.set(convId, { attempts, timerId });
  }

  // Attempts to recover a FAILED conversation by re-fetching and processing any
  // pending Welcome. Resets FAILED → EMPTY before the attempt so the state machine
  // allows the subsequent EMPTY → READY or EMPTY → FAILED transitions.
  private async recoverFromFailed(convId: string, user: UserProfile, device: DeviceInfo): Promise<void> {
    if (this.states.get(convId) !== ConversationMlsState.Failed) {
      this.failedRecovery.delete(convId);
      return;
    }

    const attempts = (this.failedRecovery.get(convId)?.attempts ?? 0) + 1;
    this.failedRecovery.set(convId, { attempts, timerId: undefined });

    this.transitionState(convId, ConversationMlsState.Empty);

    try {
      const ok = await this.fetchAndProcessPendingWelcome(convId, user, device);
      if (ok) {
        // fetchAndProcessPendingWelcome joined the group in IndexedDB — reflect that here.
        this.transitionState(convId, ConversationMlsState.Ready);
        this.failedRecovery.delete(convId);
        void this.replayPendingDecrypts(convId, user, device);
        return;
      }
      // No pending Welcome available — leave EMPTY, do not retry.
    } catch (err) {
      if (!environment.production) console.warn('[MLS:coordinator] recoverFromFailed attempt', attempts, 'for', convId, ':', err);
      this.transitionState(convId, ConversationMlsState.Failed);
      this.scheduleFailedRecovery(convId, user, device);
    }
  }

  // Single point of state modification — validates transition, updates watchdog.
  private transitionState(
    convId: string,
    to:     ConversationMlsState,
    reason?: typeof TRANSITION_REASON_RESTORE,
  ): void {
    const from = this.states.get(convId) ?? ConversationMlsState.Empty;
    MlsStateTransitionGuard.validate(from, to, convId, reason);
    this.states.set(convId, to);
    this.watchdog.watch(convId, to);

    if (to === ConversationMlsState.Ready) {
      this._conversationReady$$.next({
        conversationId: convId,
        from,
        operationId:    crypto.randomUUID(),
      });
    }
  }

  // Derives the initial state for a conversation from IndexedDB (once per conversation).
  private async getOrDeriveState(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<ConversationMlsState> {
    const cached = this.states.get(convId);
    if (cached !== undefined) return cached;

    const pending = this.pendingDerivations.get(convId);
    if (pending) return pending;

    const derivation = this.mlsSvc
      .hasGroupState(convId, user, device)
      .then(has => {
        const state = has ? ConversationMlsState.Ready : ConversationMlsState.Empty;
        this.states.set(convId, state);
        this.pendingDerivations.delete(convId);
        return state;
      });

    this.pendingDerivations.set(convId, derivation);
    return derivation;
  }

  private classifyError(err: unknown, convId: string): TransientMlsError | PermanentMlsError {
    const msg = err instanceof Error ? err.message : String(err);

    for (const [pattern, kind] of TRANSIENT_PATTERNS) {
      if (pattern.test(msg)) return new TransientMlsError(kind as never, msg, convId);
    }
    for (const [pattern, kind] of PERMANENT_PATTERNS) {
      if (pattern.test(msg)) return new PermanentMlsError(kind as never, msg, convId);
    }

    if (!environment.production) console.error('[MLS:coordinator] Unrecognized ts-mls error, classifying as PermanentMlsError:', err);
    return new PermanentMlsError('InvalidCiphertext', msg, convId);
  }

  private buildCached(
    entry:         import('../repositories/pending-decrypt.repository').PendingDecryptEntry,
    plaintext:     string,
    undecryptable: boolean,
  ): CachedMessage {
    return {
      id:                entry.messageId,
      conversationId:    entry.conversationId,
      senderDeviceId:    entry.senderDeviceId,
      senderDid:         entry.senderDid,
      plaintext,
      isMine:            entry.isMine,
      undecryptable,
      cacheVersion:      1,
      encryptionVersion: 1,
      deletedAt:         null,
      createdAt:         entry.createdAt,
      cachedAt:          Date.now(),
    };
  }
}
