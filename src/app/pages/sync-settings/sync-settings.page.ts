import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { SyncService } from '../../core/sync/sync.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-sync-settings',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './sync-settings.page.html',
  styleUrls: ['./sync-settings.page.scss'],
})
export class SyncSettingsPage implements OnInit, OnDestroy {
  private syncSvc = inject(SyncService);
  private router  = inject(Router);
  private i18n    = inject(TranslationService);
  private subs    = new Subscription();

  mbkAvailable = false;
  working      = false;
  error        = '';

  showChangePin   = false;
  newPin          = '';
  newPinConfirm   = '';
  pinChanged      = false;

  restoring       = false;
  restoreRestored = 0;
  restoreDone     = false;
  restoreError    = '';

  rebuilding             = false;
  rebuildStep: null | 'confirm1' | 'confirm2' = null;
  rebuildConfirmEnabled  = false;
  rebuildPhase           = '';
  rebuildUploaded        = 0;
  rebuildTotal           = 0;
  rebuildDone            = false;
  rebuildError           = '';

  private rebuildConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.mbkAvailable = this.syncSvc.isMbkAvailable();
    this.rebuilding   = this.syncSvc.isRebuilding();

    this.subs.add(
      this.syncSvc.restoreProgress$.subscribe(p => {
        this.restoreRestored = p.restored;
        if (p.done) {
          this.restoring    = false;
          this.restoreDone  = true;
          this.restoreError = p.error ?? '';
        }
      }),
    );

    this.subs.add(
      this.syncSvc.rebuildProgress$.subscribe(p => {
        this.rebuildPhase    = p.phase;
        this.rebuildUploaded = p.uploaded;
        this.rebuildTotal    = p.total;
        if (p.done) {
          this.rebuilding   = false;
          this.rebuildDone  = true;
          this.rebuildError = p.error ?? '';
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.rebuildConfirmTimer !== null) clearTimeout(this.rebuildConfirmTimer);
  }

  goBack(): void {
    void this.router.navigate([ROUTES.security]);
  }

  // ── Change PIN ─────────────────────────────────────────────────────────────

  onNewPinInput(event: Event): void {
    this.newPin = (event.target as HTMLInputElement).value;
  }

  onNewPinConfirmInput(event: Event): void {
    this.newPinConfirm = (event.target as HTMLInputElement).value;
  }

  async onChangePin(): Promise<void> {
    this.error = '';
    if (!/^\d{4,8}$/.test(this.newPin)) {
      this.error = this.i18n.t('common.error.pin_format');
      return;
    }
    if (this.newPin !== this.newPinConfirm) {
      this.error = this.i18n.t('common.error.pin_mismatch');
      return;
    }
    this.working = true;
    try {
      await this.syncSvc.changePin(this.newPin);
      this.newPin        = '';
      this.newPinConfirm = '';
      this.showChangePin = false;
      this.pinChanged    = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.i18n.t('sync.error.pin_change');
    } finally {
      this.working = false;
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  restore(): void {
    this.restoring       = true;
    this.restoreRestored = 0;
    this.restoreDone     = false;
    this.restoreError    = '';
    this.syncSvc.startRestore();
  }

  dismissRestore(): void {
    this.restoreDone = false;
  }

  // ── Rebuild ────────────────────────────────────────────────────────────────

  beginRebuild(): void {
    this.rebuildStep = 'confirm1';
  }

  advanceRebuildConfirm(): void {
    this.rebuildStep           = 'confirm2';
    this.rebuildConfirmEnabled = false;
    this.rebuildConfirmTimer   = setTimeout(() => {
      this.rebuildConfirmEnabled = true;
      this.rebuildConfirmTimer   = null;
    }, 3000);
  }

  cancelRebuild(): void {
    if (this.rebuildConfirmTimer !== null) {
      clearTimeout(this.rebuildConfirmTimer);
      this.rebuildConfirmTimer = null;
    }
    this.rebuildStep           = null;
    this.rebuildConfirmEnabled = false;
  }

  confirmRebuild(): void {
    this.rebuildStep  = null;
    this.rebuilding   = true;
    this.rebuildDone  = false;
    this.rebuildError = '';
    this.syncSvc.startRebuild();
  }

  dismissRebuild(): void {
    this.rebuildDone = false;
  }
}
