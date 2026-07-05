import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
})
export class SettingsPage {
  @Input() embedded = false;
  @Output() navigateBack   = new EventEmitter<void>();
  @Output() openSubPage    = new EventEmitter<string>();

  private router = inject(Router);
  goBack(): void {
    if (this.embedded) { this.navigateBack.emit(); return; }
    void this.router.navigate(['/tabs/menu']);
  }

  openAppearance(): void {
    if (this.embedded) { this.openSubPage.emit('appearance'); return; }
    void this.router.navigate(['/tabs/settings/appearance']);
  }

  openLanguage(): void {
    if (this.embedded) { this.openSubPage.emit('language'); return; }
    void this.router.navigate(['/tabs/settings/language']);
  }

  openDevices(): void {
    void this.router.navigate(['/tabs/devices']);
  }

  confirmingDelete = false;

  confirmDeleteAccount(): void {
    this.confirmingDelete = true;
  }

  cancelDeleteAccount(): void {
    this.confirmingDelete = false;
  }
}
