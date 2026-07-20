import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonToggle } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { NotificationService } from '../../core/notification/notification.service';
import { PushNotificationService } from '../../core/notification/push-notification.service';
import { ROUTES } from '../../core/routes';
import { Capacitor } from '@capacitor/core';

@Component({
  selector: 'app-settings-notifications',
  standalone: true,
  imports: [IonContent, IonIcon, IonToggle, TranslatePipe],
  templateUrl: './settings-notifications.page.html',
  styleUrls: ['./settings-notifications.page.scss'],
})
export class SettingsNotificationsPage {
  private router    = inject(Router);
  private notifySvc = inject(NotificationService);
  private pushSvc   = inject(PushNotificationService);

  readonly isNative = Capacitor.isNativePlatform();

  readonly inAppEnabled = signal<boolean>(this.notifySvc.isInAppEnabled());
  readonly pushEnabled  = signal<boolean>(this.pushSvc.isPushEnabled());

  goBack(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  toggleInApp(event: any): void {
    const checked = event.detail.checked as boolean;
    this.notifySvc.setInAppEnabled(checked);
    this.inAppEnabled.set(checked);
  }

  togglePush(event: any): void {
    const checked = event.detail.checked as boolean;
    void this.pushSvc.setPushEnabled(checked).then(() => {
      this.pushEnabled.set(checked);
    });
  }
}
