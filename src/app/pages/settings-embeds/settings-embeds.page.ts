import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonToggle } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';
import { EmbedPreferencesService } from '../../core/embed/embed-preferences.service';
import type { EmbedProviderId } from '../../core/embed/embed-provider.types';

@Component({
  selector: 'app-settings-embeds',
  standalone: true,
  imports: [IonContent, IonIcon, IonToggle, TranslatePipe],
  templateUrl: './settings-embeds.page.html',
  styleUrls: ['./settings-embeds.page.scss'],
})
export class SettingsEmbedsPage {
  private router   = inject(Router);
  protected prefsSvc = inject(EmbedPreferencesService);

  readonly externalProviders: EmbedProviderId[] = ['youtube', 'spotify', 'dailymotion', 'tiktok', 'twitch'];

  goBack(): void {
    void this.router.navigate([ROUTES.settingsPrivacy]);
  }

  toggle(provider: EmbedProviderId, event: any): void {
    const checked = event.detail.checked as boolean;
    void this.prefsSvc.setAlwaysAllow(provider, checked);
  }
}
