import { Injectable, inject } from '@angular/core';
import { Observable, Subject, firstValueFrom }   from 'rxjs';
import { environment } from '../../../../environments/environment';
import { MlsService }            from '../mls.service';
import { UserProfile }      from '../../auth/auth.types';
import { DeviceInfo }       from '../../device/device.types';
import { MessageCacheService } from '../../conversation/message-cache.service';
import { ConversationsService } from '../../conversation/conversations.service';
import type { CachedMessage } from '../../conversation/conversation.types';
import { InitializationBarrier }    from '../state-machine/initialization-barrier';
import { MlsStateTransitionGuard, TRANSITION_REASON_RESTORE } from '../state-machine/state-transition-guard';
import { PendingDecryptRepository } from '../repositories/pending-decrypt.repository';
import { TransientMlsError }        from '../errors/transient-mls-error';
import { PermanentMlsError }        from '../errors/permanent-mls-error';
import { EpochGapError }            from '../errors/epoch-gap-error';
import { MlsWatchdogService }       from '../watchdog/mls-watchdog.service';
import { MlsBackupRegistry }        from '../mls-backup-registry.service';
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
  type ConversationFailedEvent,
  type PendingDecryptQueuedEvent,
  type RestoreCompletedEvent,
  type HistoryRecoveryCompletedEvent,
} from './mls-coordinator.events';
import { MlsCoordinatorBase } from './mls-coordinator.base';

// Error message fragments from ts-mls that indicate transient vs permanent failures.
const TRANSIENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/mls group not ready/i,   'GroupNotReady'],
  [/mls not initialized/i,   'GroupNotReady'],
] as const;

const PERMANENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid mls message/i,           'InvalidCiphertext'],
  [/no matching key package/i,       'InvalidCiphertext'],
  [/invalid welcome message/i,       'InvalidCiphertext'],
  [/failed to decode mls group/i,    'CorruptedPayload'],
  [/expected application message/i,  'WireformatMismatch'],
  [/invalid mac/i,                   'InvalidSignature'],
  [/invalid signature/i,             'InvalidSignature'],
  [/verification/i,                  'InvalidSignature'],
  [/could not verify/i,              'InvalidSignature'],
  [/crypto/i,                        'InvalidSignature'],
  [/epoch too old/i,                 'EpochTooOld'],
  [/desired gen/i,                   'EpochMismatch'],
] as const;

@Injectable({ providedIn: 'root' })
export class MlsCoordinatorService extends MlsCoordinatorBase {
  private readonly mlsSvc          = inject(MlsService);
  private readonly messageCacheSvc = inject(MessageCacheService);
  private readonly pendingRepo     = inject(PendingDecryptRepository);
  private readonly watchdog        = inject(MlsWatchdogService);
  private readonly convSvc         = inject(ConversationsService);
  private readonly backupRegistry  = inject(MlsBackupRegistry);

  private currentUserProfile: UserProfile | null = null;
  private currentSessionDevice: DeviceInfo | null = null;

  private readonly barrier = new InitializationBarrier();

  // In-memory state per conversation.
  private readonly states = new Map<string, ConversationMlsState>();
  // Deduplicates concurrent state derivations for the same convId.
  private readonly pendingDerivations = new Map<string, Promise<ConversationMlsState>>();
  // Deduplicates concurrent decryptMessage calls for the same messageId.
  private readonly inFlightDecrypts = new Map<string, Promise<DecryptResult>>();

  // Auto-recovery state for FAILED conversations (backoff: 5s, 15s, 45s).
  private readonly failedRecovery = new Map<string, { attempts: number; timerId: ReturnType<typeof setTimeout> | undefined }>();

  // Consecutive processIncomingCommit failures per conversation, e.g. a commit
  // race fork (see provisionDevice) that leaves this device permanently unable
  // to verify the group's real commit chain. Reset to 0 on any successful apply.
  private readonly commitFailureCounts = new Map<string, number>();
  private static readonly MAX_COMMIT_FAILURES = 3;

  // Consecutive decryption failures (permanent errors) per conversation.
  // Triggers self-healing reset if we receive multiple undecryptable messages.
  // Kept > 1 so a single out-of-order message (legitimately unable to decrypt
  // once the group has since moved on, without indicating a real fork) gets a
  // chance at the softer fetchAndProcessPendingWelcome self-heal below before
  // escalating to a full FAILED reset.
  private readonly decryptionFailures = new Map<string, number>();
  private static readonly MAX_DECRYPTION_FAILURES = 3;

  // Tracks the timestamp when a conversation state became READY on this device.
  // Used to distinguish historical messages (which a new device naturally cannot decrypt)
  // from new real-time messages (which should decrypt).
  private readonly readyTimestamps = new Map<string, number>();

  // ── Private Subjects ───────────────────────────────────────────────────────
  private readonly _conversationReady$$    = new Subject<ConversationReadyEvent>();
  private readonly _welcomeProcessed$$     = new Subject<WelcomeProcessedEvent>();
  private readonly _commitApplied$$        = new Subject<CommitAppliedEvent>();
  private readonly _conversationFailed$$   = new Subject<ConversationFailedEvent>();
  private readonly _pendingDecryptQueued$$ = new Subject<PendingDecryptQueuedEvent>();
  private readonly _pendingDecryptReplayed$$ = new Subject<ReplayedDecryptEvent>();
  private readonly _restoreCompleted$$     = new Subject<RestoreCompletedEvent>();
  private readonly _historyRecoveryCompleted$$ = new Subject<HistoryRecoveryCompletedEvent>();

  // ── Public Observables (MlsCoordinatorBase contract) ──────────────────────
  override readonly conversationReady$      = this._conversationReady$$.asObservable();
  override readonly welcomeProcessed$       = this._welcomeProcessed$$.asObservable();
  override readonly commitApplied$          = this._commitApplied$$.asObservable();
  override readonly conversationFailed$     = this._conversationFailed$$.asObservable();
  override readonly pendingDecryptQueued$   = this._pendingDecryptQueued$$.asObservable();
  override readonly pendingDecryptReplayed$ = this._pendingDecryptReplayed$$.asObservable();
  override readonly restoreCompleted$       = this._restoreCompleted$$.asObservable();
  override readonly historyRecoveryCompleted$ = this._historyRecoveryCompleted$$.asObservable();

  constructor() {
    super();
    this.mlsSvc.epochConflict$.subscribe(event => {
      console.error('[MLS:coordinator] Epoch conflict (409) event received for', event.conversationId, '— marking FAILED.');
      this.transitionState(event.conversationId, ConversationMlsState.Failed);
      this._conversationFailed$$.next({ conversationId: event.conversationId });
      const user = this.currentUserProfile;
      const device = this.currentSessionDevice;
      if (user && device) {
        this.scheduleFailedRecovery(event.conversationId, user, device);
      }
    });
  }

  // ── Session ───────────────────────────────────────────────────────────────

  override async initializeForSession(user: UserProfile, device: DeviceInfo): Promise<void> {
    assertMls(!!user?.did,    'initializeForSession: user.did required', { user });
    assertMls(!!device?.id,   'initializeForSession: device.id required', { device });

    // All per-conversation in-memory state below (states, failedRecovery timers,
    // etc.) is keyed by conversationId ONLY, with no account/device dimension.
    // That's fine within one session, but AuthService.switchAccount() reuses
    // this same singleton without ever destroying it -- and two locally-linked
    // accounts that DM each other share the exact same conversationId. Without
    // this reset, a stale ConversationMlsState.Ready (or a scheduleFailedRecovery
    // setTimeout still pending) left behind by the PREVIOUS account leaks into
    // the newly active account's use of that same conversationId: e.g.
    // ensureGroupReady()'s `if (isConversationReady(convId)) return;` shortcut
    // (line ~262) skips real group establishment for the new account entirely,
    // or a delayed recoverFromFailed() timer fires later against the OLD
    // account's user/device closure while the NEW account is active, mutating
    // the wrong account's MLS group. Only a full page reload cleared this
    // before (it wipes the singleton), matching the reported symptom.
    if (this.currentUserProfile &&
        (this.currentUserProfile.did !== user.did || this.currentSessionDevice?.id !== device.id)) {
      for (const entry of this.failedRecovery.values()) {
        if (entry.timerId !== undefined) clearTimeout(entry.timerId);
      }
      this.failedRecovery.clear();
      this.states.clear();
      this.pendingDerivations.clear();
      this.inFlightDecrypts.clear();
      this.commitFailureCounts.clear();
      this.decryptionFailures.clear();
      this.readyTimestamps.clear();
    }

    this.currentUserProfile = user;
    this.currentSessionDevice = device;
    await this.mlsSvc.initializeForSession(user, device);
    await this.pendingRepo.initialize(user.did, device.id);
    void this.pendingRepo.pruneStale();
  }

  // ── Semantic capability checks ─────────────────────────────────────────────

  override isConversationReady(convId: string): boolean {
    return this.states.get(convId) === ConversationMlsState.Ready;
  }

  override isConversationFailed(convId: string): boolean {
    return this.states.get(convId) === ConversationMlsState.Failed;
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
        console.warn('[MLS:coordinator] processWelcome on READY state (idempotent):', err);
      }
      return;
    }

    // FAILED only allows FAILED -> EMPTY (see MlsStateTransitionGuard) — reset
    // here so a conversation marked FAILED (e.g. a permanent commit-race fork)
    // doesn't make the transition to JOINING below throw.
    if (currentState === ConversationMlsState.Failed) {
      this.transitionState(convId, ConversationMlsState.Empty);
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
    const ok = await this.mlsSvc.fetchAndProcessPendingWelcome(convId, user, device);
    if (ok) {
      this.transitionState(convId, ConversationMlsState.Ready);
      void this.replayPendingDecrypts(convId, user, device);
    }
    return ok;
  }

  // ── Group readiness ────────────────────────────────────────────────────────

  override async ensureGroupReady(
    convId:         string,
    participantDid: string,
    user:           UserProfile,
    device:         DeviceInfo,
    signal?:        AbortSignal,
    preConsumedKeyPackage?: { keyPackage: string; deviceId: string },
    memberDids?:    string[],
  ): Promise<void> {
    assertMls(!!participantDid, 'ensureGroupReady: participantDid required', { convId });
    assertMls(!!convId,         'ensureGroupReady: convId required');

    if (this.isConversationReady(convId)) return;

    // FAILED only allows FAILED -> EMPTY (see MlsStateTransitionGuard). Reset here
    // so a conversation marked FAILED by trackCommitOutcome (e.g. a permanent
    // commit-race fork) doesn't make the next transition to INITIALIZING below
    // throw — that would otherwise hard-block sending a message on this
    // conversation forever instead of at least attempting to proceed.
    if (this.states.get(convId) === ConversationMlsState.Failed) {
      this.transitionState(convId, ConversationMlsState.Empty);
    }

    const { release } = this.barrier.register(convId);

    // Re-check after barrier registration — processWelcome may have completed concurrently.
    if (this.isConversationReady(convId)) {
      release();
      return;
    }

    this.transitionState(convId, ConversationMlsState.Initializing);
    try {
      await this.mlsSvc.ensureGroupReady(convId, participantDid, user, device, signal, preConsumedKeyPackage, memberDids);
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

  // Two-tier recovery of everything this device can still reach before
  // clearConversationGroup() destroys its only copy of this conversation's
  // MLS keys:
  //
  // 1. Cloud backup (MBK-encrypted, account-wide) -- doesn't depend on this
  //    conversation's MLS state at all, so it can still recover a message
  //    even if THIS device's local MLS state is already degraded (often
  //    exactly why we're in this recovery path). Only recovers messages
  //    this account has successfully decrypted+backed-up at some point, on
  //    any of its own devices -- never the other participant's copy. Kept
  //    best-effort (own try/catch): a cloud outage must not stop the MLS
  //    sweep below, which is an independent recovery path.
  // 2. Fetches the full server-side message list for convId and, for
  //    anything still not in the local cache after (1), attempts decryption
  //    with the group state that's about to be destroyed. Calls
  //    MlsService.decryptMessage() directly rather than this class's own
  //    decryptMessage() -- that method's state-machine side effects (failure
  //    counters, transitionState(Failed), scheduleFailedRecovery) are meant
  //    for live decryption while chatting, not a best-effort sweep while
  //    we're already mid-recovery and about to clear regardless.
  //
  // A message still undecryptable after both is stored as an explicit
  // undecryptable placeholder -- same reasoning as the pendingRepo-to-
  // placeholder conversion below: a message the recipient genuinely
  // received should show as "[Encrypted]", not vanish with no trace once
  // the keys are gone.
  //
  // Unlike the cloud-restore substep, a failure to even ENUMERATE what
  // exists (server pagination, local cache read) is NOT swallowed here --
  // it propagates to clearConversationGroup(), which must not destroy keys
  // while it's not known whether every recoverable message was tried. Both
  // callers already handle a thrown clearConversationGroup() safely:
  // recoverFromFailed()'s own catch reschedules a retry with backoff, and
  // reestablishEncryption()'s Option A falls through to the Option B
  // recreate fallback exactly as it does for any other failure today.
  private async recoverMissingHistoryBeforeClear(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    if (this.backupRegistry.backupService?.isMbkAvailable()) {
      try {
        await this.backupRegistry.backupService.restore();
      } catch (err) {
        console.warn('[MLS:coordinator] recoverMissingHistoryBeforeClear: cloud restore failed', convId, err);
      }
    }

    const localIds = await this.messageCacheSvc.getAllIds(convId);
    let cursor: string | undefined;
    let hasMore = true;
    let recovered = 0;
    let stillUndecryptable = 0;

    while (hasMore) {
      const page = await firstValueFrom(this.convSvc.getMessages(convId, cursor, 100));

      for (const msg of page.data) {
        if (localIds.has(msg.id)) continue;
        const isMine = msg.senderDid === user.did;

        try {
          const plaintext = await this.mlsSvc.decryptMessage(convId, user, device, msg.ciphertext);
          await this.messageCacheSvc.store({
            id:                msg.id,
            conversationId:    convId,
            senderDeviceId:    msg.senderDeviceId,
            senderDid:         msg.senderDid,
            plaintext,
            isMine,
            undecryptable:     false,
            cacheVersion:      1,
            encryptionVersion: 1,
            deletedAt:         null,
            createdAt:         msg.createdAt,
            cachedAt:          Date.now(),
          });
          recovered++;
        } catch {
          await this.messageCacheSvc.store({
            id:                msg.id,
            conversationId:    convId,
            senderDeviceId:    msg.senderDeviceId,
            senderDid:         msg.senderDid,
            plaintext:         '',
            isMine,
            undecryptable:     true,
            cacheVersion:      1,
            encryptionVersion: 1,
            deletedAt:         null,
            createdAt:         msg.createdAt,
            cachedAt:          Date.now(),
          });
          stillUndecryptable++;
        }
      }

      cursor  = page.cursor ?? undefined;
      hasMore = page.hasMore;
    }

    console.log('[MLS:observability] recoverMissingHistoryBeforeClear', { conversationId: convId, recovered, stillUndecryptable });
    this._historyRecoveryCompleted$$.next({ conversationId: convId, recovered, stillUndecryptable });
  }

  override async clearConversationGroup(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    console.log('[MLS:observability] clearConversationGroup', { conversationId: convId, caller: 'coordinator.clearConversationGroup' });

    // Before destroying the only copy of this device's decryption keys for
    // this conversation, make sure every message they could still decrypt
    // has actually been tried -- otherwise messages never even locally known
    // about (not in cache, not in pendingRepo -- e.g. this device never
    // fetched them at all) would be lost the moment the keys are gone,
    // instead of just the ones that happened to already be queued.
    await this.recoverMissingHistoryBeforeClear(convId, user, device);

    await this.mlsSvc.clearConversationGroup(convId, user, device);

    // Messages still queued here were never written anywhere visible (see
    // decryptMessage's TransientMlsError branch: state 'pending_decrypt'
    // writes nothing to the cache, only to this queue, waiting to be
    // replayed once the group becomes ready again -- see
    // replayPendingDecrypts). Abandoning the group entirely (this method is
    // called right before recreating the conversation, or by the
    // no-welcome branch of recoverFromFailed) means that ready state will
    // never come: no key material for this conversationId will ever be
    // able to decrypt them again. Convert them to the same undecryptable
    // placeholder replayPendingDecrypts already uses for a permanent
    // failure, instead of pendingRepo.clear() silently discarding them
    // with no trace at all -- otherwise a message the recipient genuinely
    // received during the broken window would vanish from the spliced
    // history entirely, instead of showing as "[Encrypted]" like any other
    // permanently-undecryptable message.
    const pending = await this.pendingRepo.getAll(convId);
    if (pending.length > 0) {
      const placeholders = pending.map(entry => this.buildCached(entry, '', true));
      await Promise.all(placeholders.map(cached => this.messageCacheSvc.store(cached)));
      this._pendingDecryptReplayed$$.next({ conversationId: convId, messages: placeholders });
    }

    await this.pendingRepo.clear(convId);
    this.transitionState(convId, ConversationMlsState.Empty);
  }

  // Heals messages left as undecryptable placeholders by
  // recoverMissingHistoryBeforeClear() because the MBK wasn't unlocked yet
  // at the time -- cloud restore is a upsert by id (storeMany), so re-running
  // it once the MBK becomes available can turn a placeholder back into
  // plaintext. Returns how many of THIS conversation's placeholders were
  // actually healed by this call, 0 if the MBK still isn't available or
  // there was nothing to retry.
  override async retryUndecryptableViaCloudBackup(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<number> {
    if (!this.backupRegistry.backupService?.isMbkAvailable()) return 0;

    const undecryptableIds: string[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await this.messageCacheSvc.getMessagesPage(convId, cursor ?? 0, 500);
      if (page.length === 0) break;
      for (const msg of page) {
        if (msg.undecryptable) undecryptableIds.push(msg.id);
      }
      cursor = page[page.length - 1]!.createdAt;
      if (page.length < 500) break;
    }

    if (undecryptableIds.length === 0) return 0;

    try {
      await this.backupRegistry.backupService.restore();
    } catch (err) {
      console.warn('[MLS:coordinator] retryUndecryptableViaCloudBackup: cloud restore failed', convId, err);
      return 0;
    }

    let healed = 0;
    for (const id of undecryptableIds) {
      const msg = await this.messageCacheSvc.getById(id);
      if (msg && !msg.undecryptable) healed++;
    }
    return healed;
  }

  override async prepareConversation(
    user:           UserProfile,
    device:         DeviceInfo,
    participantDid: string,
  ): Promise<void> {
    assertMls(!!participantDid, 'prepareConversation: participantDid required');
    await this.mlsSvc.prepareConversationInitialization(user, device, participantDid);
  }

  override async prepareConversationWithKeyPackage(
    user:           UserProfile,
    device:         DeviceInfo,
    participantDid: string,
    convId:         string,
    keyPackage:     { keyPackage: string; deviceId: string }
  ): Promise<void> {
    assertMls(!!participantDid, 'prepareConversationWithKeyPackage: participantDid required');
    assertMls(!!convId,         'prepareConversationWithKeyPackage: convId required');
    await this.ensureGroupReady(convId, participantDid, user, device, undefined, keyPackage);
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
        console.log('[MLS:coordinator] decryptMessage success for', messageId, 'length:', plaintext.length);
        this.transitionState(convId, ConversationMlsState.Ready);
        this.decryptionFailures.set(convId, 0);
        return { messageId, conversationId: convId, state: 'plaintext' as const, plaintext, operationId };
      } catch (err) {
        const classified = this.classifyError(err, convId);
        if (classified instanceof TransientMlsError) {
          console.warn('[MLS:coordinator] decryptMessage transient error for', messageId, '->', classified.kind, ':', err instanceof Error ? err.message : err);
        } else {
          console.error('[MLS:coordinator] decryptMessage error for', messageId, '->', classified.kind, ':', err);
        }

        // FIRST: Before enqueuing as transient or marking as undecryptable, attempt to fetch & process any pending Welcome for this conversation.
        // If no Welcome is pending, attempt MBK Cloud Restore fallback to recover the group state from another device.
        try {
          let healed = await this.fetchAndProcessPendingWelcome(convId, user, device);
          if (!healed && this.backupRegistry.backupService?.isMbkAvailable()) {
            const result = await this.backupRegistry.backupService.restore() as any;
            if (result?.restoredGroupStates && result.restoredGroupStates[convId]) {
              await this.injectRestoredGroupStates(result.restoredGroupStates, user, device);
              healed = true;
            }
          }
          if (healed) {
            if (!environment.production) console.log('[MLS:coordinator] decryptMessage: group healed via Welcome/MBK, retrying decryption for', messageId);
            const retriedPlaintext = await this.mlsSvc.decryptMessage(convId, user, device, ciphertextB64);
            this.transitionState(convId, ConversationMlsState.Ready);
            this.decryptionFailures.set(convId, 0);
            return { messageId, conversationId: convId, state: 'plaintext' as const, plaintext: retriedPlaintext, operationId };
          }
        } catch (healErr) {
          if (!environment.production) console.warn('[MLS:coordinator] decryptMessage Welcome/MBK heal attempt failed:', healErr);
        }

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

        const readyTime = this.readyTimestamps.get(convId);
        const isHistorical = readyTime !== undefined && createdAt < readyTime - 5000;

        if (isHistorical) {
          if (!environment.production) console.log('[MLS:coordinator] decryptMessage: ignoring permanent decryption failure for historical message', messageId, 'createdAt =', createdAt, 'readyTime =', readyTime);
        } else {
          const failures = (this.decryptionFailures.get(convId) ?? 0) + 1;
          this.decryptionFailures.set(convId, failures);

          if (failures >= MlsCoordinatorService.MAX_DECRYPTION_FAILURES) {
            console.warn('[MLS:coordinator]', failures, 'consecutive decryption failures for', convId, '— triggering self-healing recovery');
            this.transitionState(convId, ConversationMlsState.Failed);
            this.scheduleFailedRecovery(convId, user, device);
          }
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
    return this.trackCommitOutcome(
      convId, user, device,
      () => this.mlsSvc.processIncomingCommit(convId, commitBase64, epoch, user, device),
    ).then(() => {
      this._commitApplied$$.next({ conversationId: convId, epoch, operationId });
    });
  }

  // Wraps a commit-applying operation (a single incoming commit, or a whole
  // catch-up batch) with the Ready ⇄ ApplyingCommit/Failed state machine and a
  // consecutive-failure counter. After MAX_COMMIT_FAILURES in a row for the
  // same conversation, marks it FAILED and hands off to the existing
  // scheduleFailedRecovery/recoverFromFailed machinery instead of failing
  // silently forever (e.g. a commit race fork — see provisionDevice).
  private async trackCommitOutcome(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
    op:     () => Promise<unknown>,
  ): Promise<void> {
    const wasReady = (await this.getOrDeriveState(convId, user, device)) === ConversationMlsState.Ready;
    if (wasReady) this.transitionState(convId, ConversationMlsState.ApplyingCommit);

    try {
      await op();
      this.commitFailureCounts.delete(convId);
      if (wasReady) this.transitionState(convId, ConversationMlsState.Ready);
    } catch (err) {
      if (!wasReady) throw err;

      // Forensic audit finding F8: a missed commit (not a fork) must not
      // count toward MAX_COMMIT_FAILURES or classify as permanent -- ts-mls's
      // error for this case is message-identical to a genuine crypto/fork
      // failure (see EpochGapError's own comment), so MlsService signals it
      // structurally instead. Catch up directly here, mirroring
      // recoverFromFailed's use of mlsSvc.catchUpMissedCommits() (not the
      // coordinator wrapper, to avoid re-entering this same state machine).
      if (err instanceof EpochGapError) {
        try {
          await this.mlsSvc.catchUpMissedCommits(convId, user, device);
          this.commitFailureCounts.delete(convId);
          this.transitionState(convId, ConversationMlsState.Ready);
          void this.replayPendingDecrypts(convId, user, device);
          return;
        } catch (catchUpErr) {
          // The catch-up attempt itself failed (e.g. network down) -- still
          // not evidence of a fork, so count it as an ordinary retryable
          // failure rather than falling through to classifyError() below,
          // which would classify the original EpochGapError's message as an
          // unrecognized/permanent error and mark FAILED on the very first
          // occurrence.
          console.warn('[MLS:coordinator] trackCommitOutcome: catch-up after epoch gap failed for', convId, catchUpErr);
          const gapFailures = (this.commitFailureCounts.get(convId) ?? 0) + 1;
          this.commitFailureCounts.set(convId, gapFailures);
          if (gapFailures >= MlsCoordinatorService.MAX_COMMIT_FAILURES) {
            console.error(
              '[MLS:coordinator]', gapFailures, 'consecutive commit failures for', convId,
              '(catch-up after epoch gap kept failing) — marking FAILED.',
            );
            this.transitionState(convId, ConversationMlsState.Failed);
            this._conversationFailed$$.next({ conversationId: convId });
            this.scheduleFailedRecovery(convId, user, device);
          } else {
            this.transitionState(convId, ConversationMlsState.Ready);
          }
          throw err;
        }
      }

      const failures = (this.commitFailureCounts.get(convId) ?? 0) + 1;
      this.commitFailureCounts.set(convId, failures);

      const classified = this.classifyError(err, convId);
      const isPermanentCommitFail =
        classified instanceof PermanentMlsError &&
        classified.kind !== 'EpochTooOld';

      if (failures >= MlsCoordinatorService.MAX_COMMIT_FAILURES || isPermanentCommitFail) {
        console.error(
          '[MLS:coordinator]', failures, 'consecutive commit failures for', convId,
          '— likely a permanent fork. Marking FAILED.',
        );
        this.transitionState(convId, ConversationMlsState.Failed);
        this._conversationFailed$$.next({ conversationId: convId });
        this.scheduleFailedRecovery(convId, user, device);
      } else {
        this.transitionState(convId, ConversationMlsState.Ready);
      }
      throw err;
    }
  }

  override async catchUpMissedCommits(
    convId: string,
    user:   UserProfile,
    device: DeviceInfo,
  ): Promise<void> {
    await this.trackCommitOutcome(
      convId, user, device,
      () => this.mlsSvc.catchUpMissedCommits(convId, user, device),
    );

    // A background catch-up (proactiveCatchUpSweep, socket reconnect) was the
    // only path that could bring a conversation up to date without ever
    // giving its pending_decrypt queue a chance -- the user had to open the
    // conversation by hand for replayPendingDecrypts to run. Guarded on
    // READY (i.e. this device has local group state): replaying against a
    // conversation with none throws the *transient* 'MLS group not ready',
    // which burns pendingRepo's single retry budget (replayPendingDecrypts:
    // attempts >= 1 => permanent) and would turn recoverable messages into
    // "[Encrypted]" on the next session's sweep. Deliberately NOT done inside
    // trackCommitOutcome (which also wraps a single live commit from the
    // socket): a live commit can leave the group at an intermediate epoch,
    // where a pending message from a later epoch decrypts to a permanent
    // error instead of the transient one it would get once fully caught up.
    // A completed catch-up batch cannot do that: any message this device
    // already received was sent after its own epoch's commit was posted, so
    // the batch necessarily covers it.
    if (this.isConversationReady(convId)) {
      await this.replayPendingDecrypts(convId, user, device);
    }
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

  override async removeRevokedDeviceFromAllGroups(
    revokedDeviceId: string,
    user:            UserProfile,
    device:          DeviceInfo,
  ): Promise<void> {
    assertMls(!!revokedDeviceId, 'removeRevokedDeviceFromAllGroups: revokedDeviceId required');
    return this.mlsSvc.removeRevokedDeviceFromAllGroups(revokedDeviceId, user, device);
  }

  override async reprovisionLostStateDevice(
    staleDeviceId: string,
    convId:        string,
    user:          UserProfile,
    device:        DeviceInfo,
  ): Promise<void> {
    assertMls(!!staleDeviceId, 'reprovisionLostStateDevice: staleDeviceId required', { convId });
    return this.mlsSvc.reprovisionLostStateDevice(staleDeviceId, convId, user, device);
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

    // AUDIT_08 P0: a conversation with a real processWelcome()/ensureGroupReady()
    // in flight already holds InitializationBarrier -- injecting a restored
    // candidate for it here would let TRANSITION_REASON_RESTORE force READY
    // before that real operation has verified anything. Drop those
    // conversations from this pass entirely rather than injecting a candidate
    // that could briefly sit in storage un-marked-ready: MlsService's own
    // "never overwrite an existing groupStates[convId]" check means nothing
    // is lost by waiting, and the next restore/sweep will retry them once the
    // real operation releases the barrier.
    const candidates: Record<string, string> = {};
    for (const [convId, gs] of Object.entries(groupStates)) {
      if (this.barrier.isInitializing(convId)) continue;
      candidates[convId] = gs;
    }

    // Only the conversationIds MlsService actually injected -- it can refuse
    // a candidate whose epoch would regress below what this device already
    // reached (see MlsService.injectRestoredGroupStates), and marking those
    // READY here would paper over that refusal.
    const injectedIds = Object.keys(candidates).length > 0
      ? await this.mlsSvc.injectRestoredGroupStates(candidates, user, device)
      : [];

    // Mark restored conversations as READY, bypassing normal transition rules.
    let readyCount = 0;
    for (const convId of injectedIds) {
      // Second check: a real join/init may have started registering its
      // barrier during the await above (after the first filter ran). The
      // group state was already written to storage by MlsService, but the
      // real operation's own unconditional write will still supersede it
      // once it completes -- the abstract READY label must not be forced
      // here while that operation is now in flight for convId.
      if (this.barrier.isInitializing(convId)) continue;

      const from = this.states.get(convId) ?? ConversationMlsState.Empty;
      this.transitionState(convId, ConversationMlsState.Ready, TRANSITION_REASON_RESTORE);
      if (!this.readyTimestamps.has(convId)) {
        this.readyTimestamps.set(convId, Date.now());
      }
      this.watchdog.watch(convId, ConversationMlsState.Ready);
      this._conversationReady$$.next({ conversationId: convId, from, operationId });
      readyCount++;
    }

    this._restoreCompleted$$.next({
      conversationCount: readyCount,
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
        this.backupRegistry.backupService?.enqueue({
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

    console.log('[MLS:observability] recoverFromFailed invoked', { conversationId: convId, attempt: attempts });

    this.transitionState(convId, ConversationMlsState.Empty);
    // EMPTY -> READY is not a legal transition (MlsStateTransitionGuard) --
    // without this intermediate step, fetchAndProcessPendingWelcome()'s own
    // transitionState(Ready) below throws even after a genuinely successful
    // join (the new group state is already written in MlsService by then),
    // which this method's outer catch turns into a FAILED retry; the next
    // attempt finds the Welcome already consumed and destroys the group
    // state it had just correctly repaired. JOINING -> READY and
    // JOINING -> FAILED are both legal, so this only adds a bookkeeping step.
    this.transitionState(convId, ConversationMlsState.Joining);

    try {
      const ok = await this.fetchAndProcessPendingWelcome(convId, user, device);
      if (ok) {
        // fetchAndProcessPendingWelcome joined the group in IndexedDB — reflect that here.
        console.log('[MLS:observability] recoverFromFailed outcome', { conversationId: convId, attempt: attempts, outcome: 'healed_via_welcome' });
        this.transitionState(convId, ConversationMlsState.Ready);
        this.failedRecovery.delete(convId);
        void this.replayPendingDecrypts(convId, user, device);
        return;
      }
      // No pending Welcome available. Since recovery failed and there are no
      // Welcomes, the local state is permanently forked/broken. Clear the
      // local group state so a future ensureGroupReady() attempt starts
      // clean -- but go back to FAILED (a legal EMPTY -> FAILED transition)
      // rather than leaving the state at EMPTY. isConversationFailed() is
      // the only signal that shows the "Restore encryption" button (the
      // sole remaining manual escalation path, up to a full recreate) --
      // leaving EMPTY after a failed automatic recovery silently hid that
      // button exactly when it was the only way left to unblock the user.
      if (!environment.production) console.warn('[MLS:coordinator] recoverFromFailed: no pending welcome found, clearing local group state to trigger reset', convId);

      // Before giving up on the non-destructive explanation entirely: the
      // FAILED->EMPTY->JOINING reset above is coordinator bookkeeping only --
      // MlsService's actual group state is still intact at this point, only
      // destroyed by clearConversationGroup() below. Maybe this device simply
      // missed some commits and never needed a Welcome at all. Called on
      // MlsService directly (not the coordinator wrapper) to read the
      // applied-commit count -- the wrapper's own state machine is inert
      // here anyway (state is JOINING, not Ready, so trackCommitOutcome's
      // wasReady-gated bookkeeping wouldn't fire either way.
      let appliedCommits = 0;
      try {
        appliedCommits = await this.mlsSvc.catchUpMissedCommits(convId, user, device);
      } catch (err) {
        // Never let this reach the outer catch: that would skip the
        // destructive clear below AND consume a backoff attempt, so a few
        // flaky-network retries would leave the conversation FAILED with its
        // broken state never actually reset. Fall through to the pre-existing
        // clear path unchanged. A partially-applied batch also lands here
        // (the partial count is discarded by catchUpMissedCommits itself) --
        // correct: mid-chain failure means a forked state, not a recovery.
        console.warn('[MLS:coordinator] recoverFromFailed: catch-up attempt failed', convId, err);
        appliedCommits = 0;
      }

      if (appliedCommits > 0) {
        // Those commits verified against our local state (processPublicMessage
        // checks the confirmation tag), so our chain is a valid prefix of the
        // group's and we are now current -- a genuine recovery, not a guess.
        // 0 commits proves nothing on its own (a forked device sitting at an
        // epoch >= the server's also gets 0 without throwing), so that case
        // still falls through to the clear + FAILED escalation below.
        console.log('[MLS:observability] recoverFromFailed outcome', { conversationId: convId, attempt: attempts, outcome: 'healed_via_catchup', appliedCommits });
        this.commitFailureCounts.delete(convId);
        this.transitionState(convId, ConversationMlsState.Ready);
        this.failedRecovery.delete(convId);
        void this.replayPendingDecrypts(convId, user, device);
        return;
      }

      console.log('[MLS:observability] recoverFromFailed outcome', { conversationId: convId, attempt: attempts, outcome: 'no_welcome_clearing_group_state', caller: 'recoverFromFailed' });
      // clearConversationGroup() (the coordinator's own method, which also
      // runs recoverMissingHistoryBeforeClear() and the pendingRepo ->
      // placeholder conversion) ends by resetting to EMPTY -- legal from
      // FAILED, not from JOINING (the state this function set earlier).
      // Transition to FAILED first so that reset lands on a legal edge;
      // the line right after puts it back to FAILED regardless, so the
      // net outcome is unchanged.
      this.transitionState(convId, ConversationMlsState.Failed);
      await this.clearConversationGroup(convId, user, device);
      this.transitionState(convId, ConversationMlsState.Failed);
    } catch (err) {
      console.warn('[MLS:coordinator] recoverFromFailed attempt', attempts, 'for', convId, ':', err);
      this.transitionState(convId, ConversationMlsState.Failed);
      this.scheduleFailedRecovery(convId, user, device);
    }
  }

  private transitionState(
    convId: string,
    to:     ConversationMlsState,
    reason?: typeof TRANSITION_REASON_RESTORE,
  ): void {
    const from = this.states.get(convId) ?? ConversationMlsState.Empty;
    if (from === to) return;
    MlsStateTransitionGuard.validate(from, to, convId, reason);
    this.states.set(convId, to);

    if (to === ConversationMlsState.Failed) {
      console.log('[MLS:observability] FAILED transition', { conversationId: convId, from, to });
      // Centralized here rather than left to each call site: of the several
      // places that transition a conversation to Failed (epoch conflict,
      // consecutive commit failures, consecutive decryption failures, the
      // no-welcome branch of recoverFromFailed...), only two used to emit
      // this event manually. The decryptMessage failure path -- the one
      // that actually fires in practice -- never did, so
      // conversation.page.ts's live subscription (the only thing that
      // flips mlsGroupReady to false and shows the "Restore encryption"
      // button while a conversation is already open) never fired for it.
      // Emitting unconditionally on every transition into Failed removes
      // that class of bug for good, including any future call site.
      this._conversationFailed$$.next({ conversationId: convId });
    }

    if (to === ConversationMlsState.Ready) {
      if (!this.readyTimestamps.has(convId)) {
        this.readyTimestamps.set(convId, Date.now());
      }
    } else {
      this.readyTimestamps.delete(convId);
      this.decryptionFailures.set(convId, 0);
    }
    
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
        if (state === ConversationMlsState.Ready && !this.readyTimestamps.has(convId)) {
          this.readyTimestamps.set(convId, Date.now());
        }
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

    console.error('[MLS:coordinator] Unrecognized ts-mls error, classifying as PermanentMlsError:', err);
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

  override clear(): void {
    // Clear failed recovery timers if any are pending
    this.failedRecovery.forEach(entry => {
      if (entry.timerId !== undefined) {
        clearTimeout(entry.timerId);
      }
    });
    this.failedRecovery.clear();

    this.states.clear();
    this.pendingDerivations.clear();
    this.inFlightDecrypts.clear();
    this.commitFailureCounts.clear();
    this.decryptionFailures.clear();
    this.readyTimestamps.clear();
  }
}
