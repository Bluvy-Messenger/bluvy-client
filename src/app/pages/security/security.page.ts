import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-security',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './security.page.html',
  styleUrls: ['./security.page.scss'],
})
export class SecurityPage {
  private router   = inject(Router);

  goBack(): void {
    void this.router.navigate([ROUTES.menu]);
  }

  openDevices(): void {
    void this.router.navigate([ROUTES.devices]);
  }

  openSync(): void {
    void this.router.navigate([ROUTES.settingsSync]);
  }
}
