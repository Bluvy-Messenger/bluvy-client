import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
})
export class SettingsPage {
  private router = inject(Router);

  goBack(): void {
    void this.router.navigate([ROUTES.menu]);
  }

  openAppearance(): void {
    void this.router.navigate([ROUTES.settingsAppearance]);
  }

  openLanguage(): void {
    void this.router.navigate([ROUTES.settingsLanguage]);
  }

  confirmingDelete = false;

  confirmDeleteAccount(): void {
    this.confirmingDelete = true;
  }

  cancelDeleteAccount(): void {
    this.confirmingDelete = false;
  }
}
