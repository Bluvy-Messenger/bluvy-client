import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonCard, IonCardHeader, IonCardTitle, IonCardContent,
  IonButton, IonInput, IonSpinner, IonText,
} from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { SyncService } from '../../core/sync/sync.service';
import { MlsCoordinatorBase } from '../../core/mls/coordinator/mls-coordinator.base';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-pin-unlock',
  standalone: true,
  imports: [
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonCard, IonCardHeader, IonCardTitle, IonCardContent,
    IonButton, IonInput, IonSpinner, IonText,
    TranslatePipe,
  ],
  templateUrl: './pin-unlock.page.html',
})
export class PinUnlockPage implements OnInit, OnDestroy {
  private syncSvc     = inject(SyncService);
  private authSvc     = inject(AuthService);
  private coordinator = inject(MlsCoordinatorBase);
  private router      = inject(Router);
  private i18n        = inject(TranslationService);
  private subs        = new Subscription();

  pin        = '';
  unlocking  = false;
  restoring  = false;
  restored   = 0;
  error      = '';

  ngOnInit(): void {
    this.subs.add(
      this.syncSvc.restoreProgress$.subscribe(p => {
        this.restored = p.restored;
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  onPinInput(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | null }>).detail;
    this.pin = detail?.value ?? '';
  }

  async onUnlock(): Promise<void> {
    const pin = this.pin.trim();
    if (!pin) return;
    this.unlocking = true;
    this.error     = '';
    try {
      await this.syncSvc.unlockWithPin(pin);

      this.restoring = true;
      const result   = await this.syncSvc.restore();
      const user     = this.authSvc.currentUser();
      const device   = this.authSvc.currentDevice();
      if (user && device && Object.keys(result.restoredGroupStates).length > 0) {
        await this.coordinator.injectRestoredGroupStates(result.restoredGroupStates, user, device);
      }

      await this.router.navigate([ROUTES.messages]);
    } catch (err: unknown) {
      this.restoring = false;
      const httpErr = err as { status?: number };
      if (httpErr?.status === 429) {
        this.error = this.i18n.t('pin_unlock.error.too_many');
      } else if (err instanceof DOMException && err.name === 'OperationError') {
        this.error = this.i18n.t('pin_unlock.error.wrong_pin');
      } else {
        this.error = err instanceof Error ? err.message : this.i18n.t('pin_unlock.error.unlock');
      }
    } finally {
      this.unlocking = false;
    }
  }

  goToRecovery(): void {
    void this.router.navigate([ROUTES.recoveryUnlock]);
  }
}
