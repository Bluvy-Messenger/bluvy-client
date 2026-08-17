import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { base58Decode, base58Encode } from './base58';
import { SyncRepository } from './sync.repository';
import { FailedSyncBatchRepository } from './failed-sync-batch.repository';
import {
  buildPinKdfParams,
  buildRecoveryKeyKdfParams,
  decryptFromSync,
  decryptMbk,
  deriveMbkFromRecoveryKey,
  deriveMbkWrappingKeyFromPin,
  encryptForSync,
  encryptMbk,
  importMbk,
} from './sync.crypto';
import type {
  BackfillProgress,
  MbkBlob,
  PendingSyncItem,
  RebuildProgress,
  RestoreProgress,
  RestoreResult,
  SyncDataInput,
  SyncGroupStatePlaintext,
  SyncMessagePlaintext,
  SyncPayload,
  SyncSetupResult,
} from './sync.types';
import type { CachedMessage } from '../conversation/conversation.types';
import type { UserProfile } from '../auth/auth.types';
import type { DeviceInfo } from '../device/device.types';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { ConversationsService } from '../conversation/conversations.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { MlsCoordinatorService } from '../mls/coordinator/mls-coordinator.service';
import { MlsBackupRegistry } from '../mls/mls-backup-registry.service';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE  = 100;
const FLUSH_AUTO_SIZE   = 50;


@Injectable({ providedIn: 'root' })
export class SyncService {
  private syncRepo           = inject(SyncRepository);
  private failedBatchRepo    = inject(FailedSyncBatchRepository);
  private kpSvc              = inject(KeyPackageService);
  private convSvc         = inject(ConversationsService);
  private messageCacheSvc = inject(MessageCacheService);
  private coordinatorSvc  = inject(MlsCoordinatorService);
  private backupRegistry  = inject(MlsBackupRegistry);
  private secureStorage   = inject(SecureLocalStorageService);

  constructor() {
    // Single registration point for both MlsService and MlsCoordinatorService
    // -- see mls-backup-registry.service.ts. SyncService implements the full
    // combined shape (backupGroupState + enqueue/isMbkAvailable/restore), so
    // one call here covers every MLS-side consumer.
    this.backupRegistry.setBackupService(this);
    this.coordinatorSvc.pendingDecryptQueued$.subscribe(e => {
      if (e.errorKind === 'GroupNotReady') this.onGroupNotReady();
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private mbk:       CryptoKey | null = null;
  // Bumped only by an actual MBK rotation (not by changePin(), which only
  // re-wraps the same MBK) -- compared against the backend's current
  // generation to detect a locally-cached MBK invalidated by a rotation this
  // device missed (see handleRemoteRotation() and initialize()'s freshness check).
  private keyGeneration = 1;
  private userDid:   string | null    = null;
  private deviceId:  string | null    = null;
  // Full profile/device objects, stored only so restore paths below can call
  // coordinatorSvc.injectRestoredGroupStates(...), which requires this shape
  // (only .did/.id are actually read internally, but the type is UserProfile/DeviceInfo).
  private userProfile:   UserProfile | null = null;
  private sessionDevice: DeviceInfo  | null = null;
  private rebuilding                  = false;
  private groupNotReadyRestorePending = false;
  // Coalesces concurrent restore() calls (e.g. conversation-open + onGroupNotReady
  // racing for the same broken conversation) into one underlying doRestore() pass --
  // doRestore() paginates the entire account's MBK backup, not scoped to one
  // conversation, so redundant concurrent calls are wasted client/backend load.
  private restoreInFlight: Promise<RestoreResult> | null = null;

  // ── Queue ──────────────────────────────────────────────────────────────────

  private queue:        PendingSyncItem[] = [];
  private currentFlush: Promise<void> | null = null;

  // ── Timer and event handles ────────────────────────────────────────────────

  private flushIntervalId:       number | null                          = null;
  private visibilityHandler:     (() => void) | null                    = null;
  private appStateHandlePromise: Promise<PluginListenerHandle> | null   = null;

  // ── Observables ────────────────────────────────────────────────────────────

  readonly pinRequired$        = new Subject<void>();
  readonly setupRequired$      = new Subject<void>();
  readonly migrationRequired$  = new Subject<void>();
  readonly backfillProgress$   = new Subject<BackfillProgress>();
  readonly restoreProgress$    = new Subject<RestoreProgress>();
  readonly rebuildProgress$    = new Subject<RebuildProgress>();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(userDid: string, deviceId: string, user?: UserProfile, device?: DeviceInfo): Promise<void> {
    try {
      this.userDid  = userDid;
      this.deviceId = deviceId;
      this.userProfile   = user ?? null;
      this.sessionDevice = device ?? null;

      await this.failedBatchRepo.initialize(userDid);

      // Fast path: MBK already protected locally — no PIN needed
      const hasMbkLocal = await this.secureStorage.hasMbk(userDid);
      if (hasMbkLocal) {
        const stored = await this.secureStorage.loadMbk(userDid);
        if (stored) {
          this.mbk           = await importMbk(stored.bytes as Uint8Array<ArrayBuffer>);
          this.keyGeneration = stored.keyGeneration;
          stored.bytes.fill(0);
          this.startFlushTimer();
          this.startBackfill();
          // Fire-and-forget: this device may have been offline while another
          // device rotated the MBK and missed the mbk:rotated socket push
          // entirely -- without this, it would keep encrypting new data
          // under the stale MBK forever (Path 3 never re-checks the backend
          // on its own). Deliberately not awaited so cold start stays fast.
          void this.checkMbkFreshness();
          return;
        }
      }

      // Slow path: check backend setup status
      const settings = await this.syncRepo.getSettings();
      if (settings.hasMbk) {
        // MBK exists on backend but not locally — new device or local data loss
        this.pinRequired$.next();
      } else if (settings.hasLegacyBackup) {
        // Old backup system detected — user must migrate before setting up sync
        this.migrationRequired$.next();
      } else {
        // No MBK set up at all — first-time sync setup
        this.setupRequired$.next();
      }
    } catch (err) {
      // Non-blocking: initialization errors must not prevent navigation
      if (!environment.production) console.error('[SyncService] initialize failed:', err);
    }
  }

  // ── GroupNotReady guard ───────────────────────────────────────────────────
  // Triggered when MLS cannot decrypt because the local group state is missing.
  // If MBK is already loaded, run restore silently. Otherwise prompt for PIN so
  // the user can unlock and restore from backup.
  private onGroupNotReady(): void {
    if (this.groupNotReadyRestorePending || !this.userDid) return;
    this.groupNotReadyRestorePending = true;

    if (this.mbk) {
      void this.restore()
        .then(result => {
          // AUDIT_01 W2 fast-follow: doRestore() computes restoredGroupStates
          // but a caller must explicitly inject it -- this path never did,
          // so a recovered GroupState snapshot from backup was silently
          // dropped even when it could have healed the conversation.
          if (Object.keys(result.restoredGroupStates).length > 0 && this.userProfile && this.sessionDevice) {
            void this.coordinatorSvc.injectRestoredGroupStates(result.restoredGroupStates, this.userProfile, this.sessionDevice)
              .catch(err => { if (!environment.production) console.error('[SyncService] onGroupNotReady: injectRestoredGroupStates failed', err); });
          }
        })
        .finally(() => {
          this.groupNotReadyRestorePending = false;
        });
    } else {
      this.pinRequired$.next();
      this.groupNotReadyRestorePending = false;
    }
  }

  // ── First-time sync setup ──────────────────────────────────────────────────

  // Generates MBK, wraps it with PIN and Recovery Key, uploads both blobs,
  // stores MBK locally, and starts the sync loop.
  async setupSync(pin: string): Promise<SyncSetupResult> {
    if (!this.userDid) throw new Error('Not authenticated');

    // 1. Generate MBK (32 random bytes)
    const mbkBytes = crypto.getRandomValues(new Uint8Array(32));

    // 2. Wrap MBK with PIN-derived key and upload
    const pinKdfParams   = buildPinKdfParams();
    const pinWrappingKey = await deriveMbkWrappingKeyFromPin(pin, pinKdfParams);
    const pinBlob: MbkBlob = {
      encryptedMbk: await encryptMbk(pinWrappingKey, mbkBytes),
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    pinKdfParams,
    };
    await this.syncRepo.putMbk(pinBlob);

    // 3. Generate Recovery Key, wrap MBK with it, and upload
    const recoveryKeyBytes    = crypto.getRandomValues(new Uint8Array(32));
    const recoveryKey         = base58Encode(recoveryKeyBytes);
    const recoveryKdfParams   = buildRecoveryKeyKdfParams();
    const { mbkWrappingKeyBytes, mbkWrappingKey }  = await deriveMbkFromRecoveryKey(recoveryKeyBytes, recoveryKdfParams);
    recoveryKeyBytes.fill(0);
    const recoveryBlob: MbkBlob = {
      encryptedMbk: await encryptMbk(mbkWrappingKey, mbkBytes),
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    recoveryKdfParams,
    };
    mbkWrappingKeyBytes.fill(0);
    await this.syncRepo.putRecoveryMbk(recoveryBlob);

    // 4. Persist MBK locally and activate
    this.keyGeneration = 1;
    await this.secureStorage.storeMbk(this.userDid, mbkBytes, this.keyGeneration);
    this.mbk = await importMbk(mbkBytes as Uint8Array<ArrayBuffer>);
    mbkBytes.fill(0);

    this.startFlushTimer();
    this.startBackfill();

    return { recoveryKey };
  }

  // ── Unlock flows ───────────────────────────────────────────────────────────

  // Fetches the PIN-encrypted MBK from the backend, decrypts it, stores it
  // locally, and activates the sync loop. Propagates 429 (rate-limited) errors.
  async unlockWithPin(pin: string): Promise<void> {
    if (!this.userDid) throw new Error('Not authenticated');

    const blob         = await this.syncRepo.getMbk();
    const wrappingKey  = await deriveMbkWrappingKeyFromPin(pin, blob.kdfParams);
    const mbkBytes     = await decryptMbk(wrappingKey, blob.encryptedMbk);
    const settings     = await this.syncRepo.getSettings();

    this.keyGeneration = settings.keyGeneration;
    await this.secureStorage.storeMbk(this.userDid, mbkBytes, this.keyGeneration);
    this.mbk = await importMbk(mbkBytes as Uint8Array<ArrayBuffer>);
    mbkBytes.fill(0);

    this.startFlushTimer();
    this.startBackfill();
  }

  // Fetches the Recovery Key-encrypted MBK, decrypts it, stores it locally,
  // and activates the sync loop. The caller should prompt for a new PIN
  // afterward and call changePin() to re-protect the MBK.
  async unlockWithRecoveryKey(recoveryKeyInput: string): Promise<void> {
    if (!this.userDid) throw new Error('Not authenticated');

    const blob             = await this.syncRepo.getRecoveryMbk();
    const recoveryKeyBytes = base58Decode(recoveryKeyInput.replace(/\s+/g, ''));
    const { mbkWrappingKeyBytes, mbkWrappingKey } = await deriveMbkFromRecoveryKey(recoveryKeyBytes, blob.kdfParams);
    recoveryKeyBytes.fill(0);

    const mbkBytes = await decryptMbk(mbkWrappingKey, blob.encryptedMbk);
    mbkWrappingKeyBytes.fill(0);
    const settings = await this.syncRepo.getSettings();

    this.keyGeneration = settings.keyGeneration;
    await this.secureStorage.storeMbk(this.userDid, mbkBytes, this.keyGeneration);
    this.mbk = await importMbk(mbkBytes as Uint8Array<ArrayBuffer>);
    mbkBytes.fill(0);

    this.startFlushTimer();
    this.startBackfill();
  }

  // Loads raw MBK bytes from SecureLocalStorage, re-wraps with the new PIN,
  // and replaces the PIN-encrypted blob on the backend.
  async changePin(newPin: string): Promise<void> {
    if (!this.userDid) throw new Error('Not authenticated');
    if (!this.mbk) throw new Error('MBK not available');

    const stored = await this.secureStorage.loadMbk(this.userDid);
    if (!stored) throw new Error('MBK not in local storage');

    const pinKdfParams   = buildPinKdfParams();
    const pinWrappingKey = await deriveMbkWrappingKeyFromPin(newPin, pinKdfParams);
    const encryptedBlob  = await encryptMbk(pinWrappingKey, stored.bytes as Uint8Array<ArrayBuffer>);
    stored.bytes.fill(0);

    await this.syncRepo.putMbk({
      encryptedMbk: encryptedBlob,
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    pinKdfParams,
    });
  }

  // ── MBK rotation ───────────────────────────────────────────────────────────

  // Checks a PIN against the currently-stored MBK blob without mutating any
  // state -- used to confirm the user's identity before rotateMbk() (a new
  // MBK wrapped under the wrong PIN would lock the account out of the PIN
  // path entirely). Same crypto as unlockWithPin(), just discarding the
  // decrypted bytes instead of adopting them.
  async verifyPin(pin: string): Promise<boolean> {
    try {
      const blob        = await this.syncRepo.getMbk();
      const wrappingKey = await deriveMbkWrappingKeyFromPin(pin, blob.kdfParams);
      const mbkBytes    = await decryptMbk(wrappingKey, blob.encryptedMbk);
      mbkBytes.fill(0);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'OperationError') return false;
      throw err;
    }
  }

  // Regenerates the MBK secret itself (not just its wrapping) and a new
  // Recovery Key, uploads both in one backend transaction, adopts the new
  // MBK locally, and re-encrypts the entire local history under it via the
  // existing rebuild pipeline. Called when a device is revoked, so a device
  // that already extracted the old MBK loses read access to future (and,
  // once the rebuild completes, past) backups -- see docs/CRYPTO.md.
  //
  // The Recovery Key wrapping key is never persisted (see setupSync()) --
  // the OLD Recovery Key cannot be reused to wrap the new MBK, so a brand
  // new one is generated and returned for the caller to display, exactly
  // like first-time setup.
  async rotateMbk(pin: string): Promise<SyncSetupResult> {
    if (!this.userDid) throw new Error('Not authenticated');

    const pinValid = await this.verifyPin(pin);
    if (!pinValid) throw new Error('Incorrect PIN');

    const newMbkBytes = crypto.getRandomValues(new Uint8Array(32));

    const pinKdfParams   = buildPinKdfParams();
    const pinWrappingKey = await deriveMbkWrappingKeyFromPin(pin, pinKdfParams);
    const mbkBlob: MbkBlob = {
      encryptedMbk: await encryptMbk(pinWrappingKey, newMbkBytes),
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    pinKdfParams,
    };

    const recoveryKeyBytes  = crypto.getRandomValues(new Uint8Array(32));
    const recoveryKey       = base58Encode(recoveryKeyBytes);
    const recoveryKdfParams = buildRecoveryKeyKdfParams();
    const { mbkWrappingKeyBytes, mbkWrappingKey } = await deriveMbkFromRecoveryKey(recoveryKeyBytes, recoveryKdfParams);
    recoveryKeyBytes.fill(0);
    const recoveryMbkBlob: MbkBlob = {
      encryptedMbk: await encryptMbk(mbkWrappingKey, newMbkBytes),
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    recoveryKdfParams,
    };
    mbkWrappingKeyBytes.fill(0);

    const { keyGeneration } = await this.syncRepo.rotateMbk(mbkBlob, recoveryMbkBlob);

    this.keyGeneration = keyGeneration;
    await this.secureStorage.storeMbk(this.userDid, newMbkBytes, keyGeneration);
    this.mbk = await importMbk(newMbkBytes as Uint8Array<ArrayBuffer>);
    newMbkBytes.fill(0);

    // Re-encrypts the full local history (messages; group-state backups
    // refresh incrementally on their next MLS commit, same pre-existing
    // limitation as a manual rebuild -- see docs/CRYPTO.md) under the new
    // MBK. Fire-and-forget: the caller (device revocation flow) has already
    // achieved its primary goal -- the revoked device is cut off -- by the
    // time this is called; re-encryption doesn't need to block that.
    this.startRebuild();

    return { recoveryKey };
  }

  // Invoked when this device learns (live via the mbk:rotated socket event,
  // or from the background freshness check in initialize()) that another
  // device rotated the MBK. Guards against reacting to its own rotation
  // being echoed back (the acting device is in the same 'user:<did>' socket
  // room as every other device it owns) or a stale/duplicate signal.
  //
  // Deliberately does not force pinRequired$ -- interrupting whatever the
  // user is doing to demand a PIN is unnecessary here; the existing
  // onGroupNotReady() no-MBK branch already prompts for PIN the next time
  // sync genuinely needs it.
  handleRemoteRotation(remoteKeyGeneration: number): void {
    if (remoteKeyGeneration <= this.keyGeneration) return;
    this.mbk = null;
    if (this.userDid) void this.secureStorage.clearMbk(this.userDid);
  }

  private async checkMbkFreshness(): Promise<void> {
    if (!this.userDid) return;
    try {
      const settings = await this.syncRepo.getSettings();
      this.handleRemoteRotation(settings.keyGeneration);
    } catch (err) {
      if (!environment.production) console.error('[SyncService] checkMbkFreshness failed:', err);
    }
  }

  // ── State queries ──────────────────────────────────────────────────────────

  isMbkAvailable(): boolean {
    return this.mbk !== null;
  }

  isRebuilding(): boolean {
    return this.rebuilding;
  }

  // ── Queue (public) ─────────────────────────────────────────────────────────

  // Called by external consumers (socket, send, gap-fill via MlsCoordinatorService)
  // for a single just-decrypted/just-sent message. Writes durably before any
  // network attempt (see writeDurable()) -- a message backup lost to the
  // process being killed right after decrypt is not just locally gone, it's
  // unrecoverable from the cloud too, since it was never actually flushed.
  // Silently dropped during rebuild to prevent cross-contamination.
  enqueue(item: Omit<PendingSyncItem, 'keyVersion'>): void {
    if (this.rebuilding) return;
    void this.writeDurable(item);
  }

  // Called by MlsService when MLS group state changes. Same durability
  // reasoning as enqueue() above -- a group state must never be lost to the
  // process being killed in the up-to-5s window the in-memory queue would
  // otherwise sit in unflushed. Fire-and-forget: callers (MlsService) call
  // this synchronously and don't await it.
  backupGroupState(conversationId: string, groupStateB64: string): void {
    if (this.rebuilding) return;
    void this.writeDurable({
      messageId:      `group-state:${conversationId}`,
      conversationId,
      plaintext:      groupStateB64,
      createdAt:      Date.now(),
      senderDid:      '',
      entryType:      'group-state',
    });
  }

  // Writes a single high-value item durably to IndexedDB (via
  // failedBatchRepo) before any network attempt, then triggers an immediate
  // flush -- used for both live message backups and group-state backups, the
  // two cases where losing the up-to-5s in-memory-queue window to a killed
  // process is unacceptable (unlike doLocalUpload()'s bulk backfill path,
  // which keeps using the plain in-memory queue: it already flushes
  // synchronously page-by-page and per-item durable writes for a 500-message
  // batch would be needless overhead).
  // Falls back to the in-memory queue, unchanged, when the MBK isn't
  // unlocked yet -- nothing can be encrypted regardless, and flush() already
  // retries the in-memory queue once an MBK becomes available.
  private async writeDurable(item: Omit<PendingSyncItem, 'keyVersion'>): Promise<void> {
    const mbk = this.mbk; // snapshot — key may change during the awaits below
    if (!mbk) { this.pushToQueue(item); return; }
    try {
      const encrypted = await this.encryptItem({ ...item, keyVersion: 1 }, mbk);
      await this.failedBatchRepo.saveBatch([encrypted]);
    } catch (err) {
      if (!environment.production) console.error('[SyncService] writeDurable: durable write failed:', err);
      return;
    }
    void this.flush();
  }

  // Returns the in-flight flush Promise if one is already running.
  async flush(): Promise<void> {
    if (this.currentFlush) return this.currentFlush;
    // No early-return on an empty in-memory queue: runFlush() must still
    // drain failedBatchRepo, which is where backupGroupState() now writes
    // durably ahead of the network attempt (and where any prior flush
    // failure -- message or group-state -- ends up for retry).
    if (!this.mbk) return;
    this.currentFlush = this.runFlush().finally(() => { this.currentFlush = null; });
    return this.currentFlush;
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  startFlushTimer(): void {
    this.stopFlushTimer();

    this.flushIntervalId = window.setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);

    this.visibilityHandler = () => {
      if (document.hidden) void this.flush();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    if (Capacitor.isNativePlatform()) {
      this.appStateHandlePromise = App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) void this.flush();
      });
    }
  }

  stopFlushTimer(): void {
    if (this.flushIntervalId !== null) {
      window.clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }

    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.appStateHandlePromise) {
      void this.appStateHandlePromise.then(h => h.remove());
      this.appStateHandlePromise = null;
    }
  }

  clearQueue(): void {
    this.queue = [];
  }

  // ── Backfill / Restore / Rebuild ───────────────────────────────────────────

  startBackfill(): void {
    void this.doBackfill();
  }

  startRestore(): void {
    void this.doRestore();
  }

  // Triggered only by explicit user action in sync settings.
  startRebuild(): void {
    void this.doRebuild();
  }

  // Public awaitable restore. Coalesces concurrent callers into a single
  // doRestore() pass -- see restoreInFlight.
  async restore(): Promise<RestoreResult> {
    if (this.restoreInFlight) return this.restoreInFlight;
    this.restoreInFlight = this.doRestore().finally(() => { this.restoreInFlight = null; });
    return this.restoreInFlight;
  }

  // Clears in-memory state only. SecureLocalStorage is preserved across sessions.
  reset(): void {
    this.stopFlushTimer();
    this.clearQueue();
    this.mbk           = null;
    this.keyGeneration = 1;
    this.userDid       = null;
    this.deviceId      = null;
    this.rebuilding    = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async runFlush(): Promise<void> {
    // Retry previously failed batches first (FIFO order by savedAt).
    const failedBatches = await this.failedBatchRepo.getAll().catch(() => []);
    for (const { batchId, items } of failedBatches) {
      try {
        await this.syncRepo.postData(items);
        await this.failedBatchRepo.remove(batchId).catch(() => {});
      } catch (err) {
        if (this.isNetworkError(err)) return;
        if (!environment.production) console.error('[SyncService] retry of failed batch still failing:', err);
      }
    }

    while (this.queue.length > 0 && this.mbk) {
      const batch = this.queue.splice(0, FLUSH_BATCH_SIZE);
      const mbk   = this.mbk; // snapshot — key may change during await
      const items: SyncDataInput[] = [];
      const results = await Promise.allSettled(batch.map(item => this.encryptItem(item, mbk)));
      for (let i = 0; i < results.length; i++) {
        const res = results[i]!;
        if (res.status === 'fulfilled') {
          items.push(res.value);
        } else {
          if (!environment.production) console.error('[SyncService] encrypt error for item:', batch[i], res.reason);
        }
      }
      if (items.length === 0) {
        continue;
      }
      try {
        await this.syncRepo.postData(items);
      } catch (err) {
        if (this.isNetworkError(err)) {
          this.queue.unshift(...batch);
          return;
        }
        await this.failedBatchRepo.saveBatch(items).catch(() => {});
        if (!environment.production) console.error('[SyncService] flush error (batch saved for retry):', err);
      }
    }
  }

  private async ensureCacheInitialized(): Promise<void> {
    if (!this.userDid || !this.deviceId) throw new Error('Not authenticated');
    if (!this.messageCacheSvc.isInitialized()) {
      await this.messageCacheSvc.initialize(this.userDid, this.deviceId);
    }
  }

  private async doRestore(): Promise<RestoreResult> {
    let downloaded = 0;
    let restored   = 0;
    const restoredGroupStates: Record<string, string> = {};

    try {
      if (!this.mbk) throw new Error('MBK not available');

      await this.ensureCacheInitialized();

      const mbk   = this.mbk; // snapshot
      let cursor: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const params: Record<string, string> = { limit: '100' };
        if (cursor) params['after'] = cursor;

        const page = await this.syncRepo.getData(params);
        const batch: CachedMessage[] = [];

        for (const item of page.data) {
          downloaded++;
          try {
            const raw           = await decryptFromSync(mbk, item.encryptedPayload) as unknown as Record<string, unknown>;
            const schemaVersion = typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : 1;
            const type          = typeof raw['type'] === 'string' ? raw['type'] as string : 'message';

            switch (type) {
              case 'message': {
                const p     = raw as unknown as SyncMessagePlaintext;

                // Respect a local-only "Clear Local History" on this device: don't let
                // the backup silently repopulate messages the user cleared here, while
                // still allowing genuine multi-device restores of everything else.
                const clearedAt = this.messageCacheSvc.getHistoryClearedAt(p.conversationId);
                if (clearedAt !== null && p.createdAt <= clearedAt) break;

                const isMine = p.senderDid !== undefined
                  ? p.senderDid === this.userDid
                  : false;
                batch.push({
                  id:                p.messageId,
                  conversationId:    p.conversationId,
                  senderDeviceId:    '',
                  senderDid:         p.senderDid,
                  plaintext:         p.plaintext,
                  isMine,
                  undecryptable:     false,
                  cacheVersion:      item.cacheVersion,
                  encryptionVersion: item.encryptionVersion,
                  deletedAt:         null,
                  createdAt:         p.createdAt,
                  cachedAt:          Date.now(),
                });
                restored++;
                break;
              }
              case 'group-state': {
                const p = raw as unknown as SyncGroupStatePlaintext;
                restoredGroupStates[p.conversationId] = p.groupState;
                break;
              }
              default:
                if (!environment.production) console.warn(`[SyncService] doRestore: unknown entry type '${type}' (schema v${schemaVersion}) — skipping`);
                break;
            }
          } catch {
            // Decryption failure — skip entry
          }
        }

        if (batch.length > 0) {
          await this.messageCacheSvc.storeMany(batch);
        }
        this.restoreProgress$.next({ downloaded, restored, done: false });

        cursor  = page.cursor ?? undefined;
        hasMore = page.hasMore;
      }

      if (this.userDid && this.deviceId) {
        await this.kpSvc.ensureKeyPackagePool(this.userDid, this.deviceId)
          .catch(err => { if (!environment.production) console.error('[SyncService] doRestore: ensureKeyPackagePool failed', err); });
      }

      this.restoreProgress$.next({ downloaded, restored, done: true });
      return { restoredMessages: restored, restoredGroupStates };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Restore failed';
      if (!environment.production) console.error('[SyncService] restore error:', err);
      this.restoreProgress$.next({ downloaded, restored, done: true, error });
      return { restoredMessages: restored, restoredGroupStates };
    }
  }

  private async doBackfill(): Promise<void> {
    try {
      await this.ensureCacheInitialized();
      const serverIds = await this.fetchServerIds();
      const uploaded  = await this.doLocalUpload(serverIds);
      await this.flush();
      this.backfillProgress$.next({ total: uploaded, uploaded, done: true });

      // After upload (stale records deleted during doLocalUpload), check if server
      // has messages absent from local cache and restore them if so.
      if (serverIds.size > 0) {
        const localIds  = await this.getAllLocalIds();
        const hasMissing = [...serverIds].some(id => !localIds.has(id));
        if (hasMissing) {
          await this.doRestore();
        }
      }
    } catch (err) {
      if (!environment.production) console.error('[SyncService] backfill error:', err);
    }
  }

  private async doRebuild(): Promise<void> {
    let total    = 0;
    let uploaded = 0;

    try {
      if (!this.mbk) throw new Error('MBK not available');

      await this.ensureCacheInitialized();

      total = await this.countLocalMessages();
      this.rebuildProgress$.next({ phase: 'deleting', uploaded: 0, total, done: false });

      this.stopFlushTimer();
      await this.flush();
      this.clearQueue();
      this.rebuilding = true;

      await this.syncRepo.deleteData();

      this.rebuildProgress$.next({ phase: 'uploading', uploaded: 0, total, done: false });

      uploaded = await this.doLocalUpload(new Set<string>(), (up) => {
        uploaded = up;
        this.rebuildProgress$.next({ phase: 'uploading', uploaded: up, total, done: false });
      });

      this.rebuilding = false;
      await this.flush();

      this.rebuildProgress$.next({ phase: 'done', uploaded, total, done: true });
    } catch (err) {
      this.rebuilding = false;
      const error = err instanceof Error ? err.message : 'Rebuild failed';
      if (!environment.production) console.error('[SyncService] rebuild error:', err);
      this.rebuildProgress$.next({ phase: 'done', uploaded, total, done: true, error });
    } finally {
      this.rebuilding = false;
      this.startFlushTimer();
    }
  }

  private async fetchServerIds(): Promise<Set<string>> {
    const serverIds = new Set<string>();
    let hasMore     = true;
    let afterId: string | undefined;

    while (hasMore) {
      const params: Record<string, string> = { limit: '500' };
      if (afterId) params['after'] = afterId;
      const page = await this.syncRepo.getDataIds(params);
      for (const item of page.data) serverIds.add(item.messageId);
      afterId = page.cursor ?? undefined;
      hasMore = page.hasMore;
    }

    return serverIds;
  }

  private async doLocalUpload(
    serverIds:   Set<string>,
    onProgress?: (uploaded: number) => void,
  ): Promise<number> {
    let convCursor: string | undefined;
    let convHasMore = true;
    let uploaded    = 0;

    while (convHasMore) {
      const convsPage = await firstValueFrom(this.convSvc.getConversations(convCursor, 20));

      for (const conv of convsPage.data) {
        const participantDid = conv.participant.did;
        let afterCreatedAt   = 0;
        let pageHasMore      = true;

        while (pageHasMore) {
          const messages = await this.messageCacheSvc.getMessagesPage(conv.id, afterCreatedAt, 500);

          for (const msg of messages) {
            if (msg.undecryptable) continue;
            if (msg.isMine && msg.plaintext === '') continue;
            if (serverIds.has(msg.id)) continue;

            const senderDid = msg.senderDid ?? (msg.isMine ? this.userDid! : participantDid);
            this.pushToQueue({
              messageId:      msg.id,
              conversationId: msg.conversationId,
              plaintext:      msg.plaintext,
              createdAt:      msg.createdAt,
              senderDid,
            });
            uploaded++;
          }

          if (this.queue.length > 0) await this.flush();
          onProgress?.(uploaded);

          pageHasMore = messages.length === 500;
          if (pageHasMore) afterCreatedAt = messages[messages.length - 1]!.createdAt;
        }
      }

      convCursor  = convsPage.cursor ?? undefined;
      convHasMore = convsPage.hasMore;
    }

    return uploaded;
  }

  private async countLocalMessages(): Promise<number> {
    let total   = 0;
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const page = await firstValueFrom(this.convSvc.getConversations(cursor, 20));
      for (const conv of page.data) {
        const ids = await this.messageCacheSvc.getAllIds(conv.id);
        total += ids.size;
      }
      cursor  = page.cursor ?? undefined;
      hasMore = page.hasMore;
    }

    return total;
  }

  private async getAllLocalIds(): Promise<Set<string>> {
    const all     = new Set<string>();
    let cursor: string | undefined;
    let hasMore   = true;

    while (hasMore) {
      const page = await firstValueFrom(this.convSvc.getConversations(cursor, 20));
      for (const conv of page.data) {
        const ids = await this.messageCacheSvc.getAllIds(conv.id);
        ids.forEach(id => all.add(id));
      }
      cursor  = page.cursor ?? undefined;
      hasMore = page.hasMore;
    }

    return all;
  }

  private pushToQueue(item: Omit<PendingSyncItem, 'keyVersion'>): void {
    if (this.mbk === null) return;
    this.queue.push({ ...item, keyVersion: 1 });
    if (this.queue.length >= FLUSH_AUTO_SIZE) void this.flush();
  }

  private async encryptItem(item: PendingSyncItem, mbk: CryptoKey): Promise<SyncDataInput> {
    let plain: SyncPayload;
    if (item.entryType === 'group-state') {
      plain = {
        schemaVersion:  1,
        type:           'group-state',
        conversationId: item.conversationId,
        groupState:     item.plaintext,
      };
    } else {
      plain = {
        schemaVersion:  1,
        type:           'message',
        plaintext:      item.plaintext,
        conversationId: item.conversationId,
        messageId:      item.messageId,
        createdAt:      item.createdAt,
        senderDid:      item.senderDid,
      };
    }
    const payload = await encryptForSync(mbk, plain);
    return {
      conversationId:    item.conversationId,
      messageId:         item.messageId,
      encryptedPayload:  payload,
      encryptionVersion: payload.encryptionVersion,
      cacheVersion:      payload.cacheVersion,
      keyVersion:        1,
      createdAt:         item.createdAt,
      entryType:         item.entryType,
    };
  }

  private isNetworkError(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 0;
  }
}
