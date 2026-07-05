import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

@Component({
  selector: 'app-security',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './security.page.html',
  styleUrls: ['./security.page.scss'],
})
export class SecurityPage {
  private location = inject(Location);
  private router   = inject(Router);

  @Input()  embedded     = false;
  @Output() navigateBack = new EventEmitter<void>();
  @Output() openSubPage  = new EventEmitter<string>();

  goBack(): void {
    if (this.embedded) { this.navigateBack.emit(); return; }
    this.location.back();
  }

  openDevices(): void {
    if (this.embedded) { this.openSubPage.emit('devices'); return; }
    void this.router.navigate(['/tabs/devices']);
  }

  openSync(): void {
    if (this.embedded) { this.openSubPage.emit('sync-settings'); return; }
    void this.router.navigate(['/tabs/sync-settings']);
  }
}
