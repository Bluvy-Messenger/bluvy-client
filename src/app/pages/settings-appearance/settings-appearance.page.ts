import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { ThemeService, type ThemeMode } from '../../core/theme/theme.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-settings-appearance',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-appearance.page.html',
  styleUrls: ['./settings-appearance.page.scss'],
})
export class SettingsAppearancePage {
  private router   = inject(Router);
  private themeSvc = inject(ThemeService);

  readonly preference = this.themeSvc.preference;

  goBack(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  setMode(mode: ThemeMode): void {
    this.themeSvc.set(mode);
  }
}
