import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonCard, IonCardHeader, IonCardTitle, IonCardContent,
  IonButton, IonInput, IonSpinner, IonText,
} from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { SyncService } from '../../core/sync/sync.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { environment } from '../../../environments/environment';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';

@Component({
  selector: 'app-recovery-unlock',
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonCard, IonCardHeader, IonCardTitle, IonCardContent,
    IonButton, IonInput, IonSpinner, IonText,
    TranslatePipe,
  ],
  templateUrl: './recovery-unlock.page.html',
})
export class RecoveryUnlockPage {
  private syncSvc     = inject(SyncService);
  private authSvc     = inject(AuthService);
  private coordinator = inject(MlsCoordinatorBase);
  private router      = inject(Router);
  private i18n        = inject(TranslationService);

  step            = 'key' as 'key' | 'pin';
  recoveryInput   = '';
  pin             = '';
  pinConfirm      = '';
  working         = false;
  error           = '';

  onRecoveryInput(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | null }>).detail;
    this.recoveryInput = detail?.value ?? '';
  }

  onPinInput(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | null }>).detail;
    this.pin = detail?.value ?? '';
  }

  onPinConfirmInput(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | null }>).detail;
    this.pinConfirm = detail?.value ?? '';
  }

  async onUnlockWithRecovery(): Promise<void> {
    const key = this.recoveryInput.trim();
    if (!key) return;
    this.working = true;
    this.error   = '';
    try {
      await this.syncSvc.unlockWithRecoveryKey(key);
      this.recoveryInput = '';
      this.step = 'pin';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'OperationError') {
        this.error = this.i18n.t('recovery_unlock.error.invalid_key');
      } else {
        this.error = err instanceof Error ? err.message : this.i18n.t('recovery_unlock.error.unlock');
      }
    } finally {
      this.working = false;
    }
  }

  async onSetNewPin(): Promise<void> {
    this.error = '';
    if (!/^\d{4,8}$/.test(this.pin)) {
      this.error = this.i18n.t('common.error.pin_format');
      return;
    }
    if (this.pin !== this.pinConfirm) {
      this.error = this.i18n.t('common.error.pin_mismatch');
      return;
    }
    this.working = true;
    try {
      await this.syncSvc.changePin(this.pin);
    } catch {
      // Non-blocking — MBK is in SecureLocalStorage, user can change PIN later
    }
    try {
      const result = await this.syncSvc.restore();
      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (user && device && Object.keys(result.restoredGroupStates).length > 0) {
        await this.coordinator.injectRestoredGroupStates(result.restoredGroupStates, user, device);
      }
    } catch (err) {
      this.error = this.i18n.t('recovery_unlock.error.restore');
      if (!environment.production) console.error('[RecoveryUnlock] restore failed:', err);
    }
    this.working = false;
    await this.router.navigate(['/tabs/conversations']);
  }

  async onSkipPin(): Promise<void> {
    await this.router.navigate(['/tabs/conversations']);
  }
}
