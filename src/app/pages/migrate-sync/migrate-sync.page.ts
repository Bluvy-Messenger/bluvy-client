import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonCard, IonCardHeader, IonCardTitle, IonCardContent,
  IonButton, IonTextarea, IonSpinner, IonText,
} from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { BackupRepository } from '../../core/backup/backup.repository';
import { MessageCacheService } from '../../core/conversation/message-cache.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { deriveBackupKey, decryptFromBackup } from '../../core/backup/backup.crypto';
import { base58Decode } from '../../core/backup/base58';
import type {
  Argon2idHkdfParams,
  BackupMessagePlaintext,
  BackupGroupStatePlaintext,
} from '../../core/backup/backup.types';
import type { CachedMessage } from '../../core/conversation/conversation.types';

function isArgon2idHkdfParams(params: unknown): params is Argon2idHkdfParams {
  return typeof params === 'object' && params !== null && 'argon2Salt' in params;
}

@Component({
  selector: 'app-migrate-sync',
  standalone: true,
  imports: [
    FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonCard, IonCardHeader, IonCardTitle, IonCardContent,
    IonButton, IonTextarea, IonSpinner, IonText,
    TranslatePipe,
  ],
  templateUrl: './migrate-sync.page.html',
  styleUrls: ['./migrate-sync.page.scss'],
})
export class MigrateSyncPage {
  private authSvc         = inject(AuthService);
  private i18n            = inject(TranslationService);
  private backupRepo      = inject(BackupRepository);
  private messageCacheSvc = inject(MessageCacheService);
  private coordinator     = inject(MlsCoordinatorBase);
  private router          = inject(Router);

  step: 'info' | 'restore' | 'restoring' | 'done' = 'info';
  recoveryKeyInput = '';
  working          = false;
  error            = '';
  restoredCount    = 0;
  groupStateCount  = 0;

  get isValidRecoveryKey(): boolean {
    const key = this.recoveryKeyInput.trim().replace(/\s+/g, '');
    return key.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(key);
  }

  async onSkip(): Promise<void> {
    await this.router.navigate(['/setup-sync']);
  }

  onStartRestore(): void {
    this.step  = 'restore';
    this.error = '';
  }

  onBack(): void {
    this.step  = 'info';
    this.error = '';
  }

  async onRestore(): Promise<void> {
    const key = this.recoveryKeyInput.trim().replace(/\s+/g, '');
    if (!key) return;

    const user   = this.authSvc.currentUser();
    const device = this.authSvc.currentDevice();
    if (!user || !device) return;

    this.working = true;
    this.error   = '';
    this.step    = 'restoring';

    try {
      // 1. Get key versions from backup backend
      const { data: versions } = await this.backupRepo.getKeyVersions();
      const current = versions.find(v => v.supersededAt === null);
      if (!current) throw new Error('No backup found on server.');

      if (!isArgon2idHkdfParams(current.kdfParams)) {
        throw new Error('Unsupported backup format. Please contact support.');
      }

      // 2. Decode and derive backup key
      let recoveryKeyBytes: Uint8Array;
      try {
        recoveryKeyBytes = base58Decode(key);
      } catch {
        throw new Error('Invalid recovery key format.');
      }

      const { backupKey } = await deriveBackupKey(
        recoveryKeyBytes,
        current.kdfParams as Argon2idHkdfParams,
      );
      recoveryKeyBytes.fill(0);

      // 3. Initialize message cache
      await this.messageCacheSvc.initialize(user.did, device.id);

      // 4. Paginate and decrypt all backup messages
      const restoredGroupStates: Record<string, string> = {};
      let cursor: string | undefined;
      let hasMore  = true;
      let restored = 0;

      while (hasMore) {
        const params: Record<string, string> = { limit: '100' };
        if (cursor) params['after'] = cursor;
        const page = await this.backupRepo.getMessages(params);

        const batch: CachedMessage[] = [];
        for (const item of page.data) {
          if (item.keyVersion !== current.versionNumber) continue;
          try {
            const raw = await decryptFromBackup(backupKey, item.encryptedPayload);
            if (raw.type === 'message') {
              const p = raw as BackupMessagePlaintext;
              batch.push({
                id:                p.messageId,
                conversationId:    p.conversationId,
                senderDeviceId:    '',
                senderDid:         p.senderDid,
                plaintext:         p.plaintext,
                isMine:            p.senderDid === user.did,
                undecryptable:     false,
                cacheVersion:      item.cacheVersion,
                encryptionVersion: item.encryptionVersion,
                deletedAt:         null,
                createdAt:         p.createdAt,
                cachedAt:          Date.now(),
              });
              restored++;
            } else if (raw.type === 'group-state') {
              const p = raw as BackupGroupStatePlaintext;
              restoredGroupStates[p.conversationId] = p.groupState;
            }
          } catch { /* skip undecryptable entries */ }
        }

        if (batch.length > 0) {
          await this.messageCacheSvc.storeMany(batch);
        }

        cursor  = page.cursor ?? undefined;
        hasMore = page.hasMore;
      }

      // 5. Inject restored MLS group states
      const gsCount = Object.keys(restoredGroupStates).length;
      if (gsCount > 0) {
        await this.coordinator.injectRestoredGroupStates(restoredGroupStates, user, device);
      }

      this.restoredCount   = restored;
      this.groupStateCount = gsCount;
      this.recoveryKeyInput = '';
      this.step            = 'done';
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.i18n.t('migrate_sync.error.restore');
      this.step  = 'restore';
    } finally {
      this.working = false;
    }
  }

  async onContinue(): Promise<void> {
    await this.router.navigate(['/setup-sync']);
  }
}
