import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { IonContent, IonIcon, IonCheckbox } from '@ionic/angular/standalone';
import { SyncService } from '../../core/sync/sync.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-setup-sync',
  standalone: true,
  imports: [FormsModule, IonContent, IonIcon, IonCheckbox, TranslatePipe],
  templateUrl: './setup-sync.page.html',
  styleUrls: ['./setup-sync.page.scss'],
})
export class SetupSyncPage {
  private syncSvc = inject(SyncService);
  private router  = inject(Router);
  private i18n    = inject(TranslationService);

  step           = 'pin' as 'pin' | 'key';
  pin            = '';
  pinConfirm     = '';
  working        = false;
  error          = '';
  recoveryKey    = '';
  recoveryChunks = [] as string[];
  acknowledged   = false;

  async onSetupPin(): Promise<void> {
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
      const result        = await this.syncSvc.setupSync(this.pin);
      this.recoveryKey    = result.recoveryKey;
      this.recoveryChunks = this.chunk(result.recoveryKey, 8);
      this.pin            = '';
      this.pinConfirm     = '';
      this.step           = 'key';
    } catch (err) {
      this.error = err instanceof Error ? err.message : this.i18n.t('setup_sync.error.setup');
    } finally {
      this.working = false;
    }
  }

  async copyKey(): Promise<void> {
    try { await navigator.clipboard.writeText(this.recoveryKey); } catch { /* ignore */ }
  }

  async onContinue(): Promise<void> {
    await this.router.navigate([ROUTES.conversations]);
  }

  private chunk(s: string, n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  }
}
