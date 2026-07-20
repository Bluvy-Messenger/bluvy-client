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
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { ConversationsService } from '../conversation/conversations.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { MlsService } from '../mls/mls.service';
import { MlsCoordinatorService } from '../mls/coordinator/mls-coordinator.service';
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
  private mlsSvc          = inject(MlsService);
  private coordinatorSvc  = inject(MlsCoordinatorService);
  private secureStorage   = inject(SecureLocalStorageService);

  constructor() {
    this.mlsSvc.setBackupService(this);
    this.coordinatorSvc.setBackupService(this);
    this.coordinatorSvc.pendingDecryptQueued$.subscribe(e => {
      if (e.errorKind === 'GroupNotReady') this.onGroupNotReady();
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private mbk:       CryptoKey | null = null;
  private userDid:   string | null    = null;
  private deviceId:  string | null    = null;
  private rebuilding                  = false;
  private groupNotReadyRestorePending = false;

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

  async initialize(userDid: string, deviceId: string): Promise<void> {
    try {
      this.userDid  = userDid;
      this.deviceId = deviceId;

      await this.failedBatchRepo.initialize(userDid);

      // Fast path: MBK already protected locally — no PIN needed
      const hasMbkLocal = await this.secureStorage.hasMbk(userDid);
      if (hasMbkLocal) {
        const mbkBytes = await this.secureStorage.loadMbk(userDid);
        if (mbkBytes) {
          this.mbk = await importMbk(mbkBytes as Uint8Array<ArrayBuffer>);
          mbkBytes.fill(0);
          this.startFlushTimer();
          this.startBackfill();
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
      void this.doRestore().finally(() => {
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
    await this.secureStorage.storeMbk(this.userDid, mbkBytes);
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

    await this.secureStorage.storeMbk(this.userDid, mbkBytes);
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

    await this.secureStorage.storeMbk(this.userDid, mbkBytes);
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

    const mbkBytes = await this.secureStorage.loadMbk(this.userDid);
    if (!mbkBytes) throw new Error('MBK not in local storage');

    const pinKdfParams   = buildPinKdfParams();
    const pinWrappingKey = await deriveMbkWrappingKeyFromPin(newPin, pinKdfParams);
    const encryptedBlob  = await encryptMbk(pinWrappingKey, mbkBytes as Uint8Array<ArrayBuffer>);
    mbkBytes.fill(0);

    await this.syncRepo.putMbk({
      encryptedMbk: encryptedBlob,
      kdfAlgorithm: 'argon2id_hkdf',
      kdfParams:    pinKdfParams,
    });
  }

  // ── State queries ──────────────────────────────────────────────────────────

  isMbkAvailable(): boolean {
    return this.mbk !== null;
  }

  isRebuilding(): boolean {
    return this.rebuilding;
  }

  // ── Queue (public) ─────────────────────────────────────────────────────────

  // Called by external consumers (socket, send, gap-fill via MlsCoordinatorService).
  // Silently dropped during rebuild to prevent cross-contamination.
  enqueue(item: Omit<PendingSyncItem, 'keyVersion'>): void {
    if (this.rebuilding) return;
    this.pushToQueue(item);
  }

  // Called by MlsService when MLS group state changes.
  backupGroupState(conversationId: string, groupStateB64: string): void {
    if (this.rebuilding) return;
    this.pushToQueue({
      messageId:      `group-state:${conversationId}`,
      conversationId,
      plaintext:      groupStateB64,
      createdAt:      Date.now(),
      senderDid:      '',
      entryType:      'group-state',
    });
  }

  // Returns the in-flight flush Promise if one is already running.
  async flush(): Promise<void> {
    if (this.currentFlush) return this.currentFlush;
    if (this.queue.length === 0 || !this.mbk) return;
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

  // Public awaitable restore.
  async restore(): Promise<RestoreResult> {
    return this.doRestore();
  }

  // Clears in-memory state only. SecureLocalStorage is preserved across sessions.
  reset(): void {
    this.stopFlushTimer();
    this.clearQueue();
    this.mbk        = null;
    this.userDid    = null;
    this.deviceId   = null;
    this.rebuilding = false;
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
      let   items: SyncDataInput[];
      try {
        items = await Promise.all(batch.map(item => this.encryptItem(item, mbk)));
      } catch (err) {
        if (!environment.production) console.error('[SyncService] encrypt error (batch discarded):', err);
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
