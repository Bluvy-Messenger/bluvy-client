import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-settings-privacy',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-privacy.page.html',
  styleUrls: ['./settings-privacy.page.scss'],
})
export class SettingsPrivacyPage {
  private router = inject(Router);

  goBack(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  openEmbeds(): void {
    void this.router.navigate([ROUTES.settingsEmbeds]);
  }

  openBadge(): void {
    void this.router.navigate([ROUTES.settingsBadge]);
  }
}
