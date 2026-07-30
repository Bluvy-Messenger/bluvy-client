import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { PushNotificationService } from '../../core/notification/push-notification.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-notification-setup',
  standalone: true,
  imports: [IonContent, IonIcon],
  templateUrl: './notification-setup.page.html',
  styleUrls: ['./notification-setup.page.scss'],
})
export class NotificationSetupPage {
  private readonly pushSvc = inject(PushNotificationService);
  private readonly router  = inject(Router);

  working = false;

  async enableNotifications(): Promise<void> {
    this.working = true;
    try {
      await this.pushSvc.requestPermissionsFromUser();
    } finally {
      this.working = false;
      void this.finish();
    }
  }

  skip(): void {
    this.pushSvc.markPermissionPrompted();
    void this.finish();
  }

  private async finish(): Promise<void> {
    await this.router.navigate([ROUTES.conversations], { replaceUrl: true });
  }
}
