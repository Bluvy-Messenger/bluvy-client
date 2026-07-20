import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { ApiClientService } from '../infrastructure/api-client.service';
import { ROUTES } from '../routes';

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly apiClient = inject(ApiClientService);
  private readonly router    = inject(Router);

  initialize(): void {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    // Check if user disabled push notifications
    if (!this.isPushEnabled()) {
      return;
    }

    // 1. Request permission and register
    this.registerPush();

    // 2. Listeners
    PushNotifications.addListener('registration', async (token) => {
      // Send token to backend
      try {
        await this.apiClient.post('/v1/devices/push-token', {
          token: token.value,
          platform: 'fcm',
        });
      } catch (err) {
        console.error('[PushNotificationService] Failed to upload push token to backend:', err);
      }
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushNotificationService] Registration error:', error);
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('[PushNotificationService] Foreground notification received:', notification);
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
      const data = notification.notification.data;
      const conversationId = data['conversationId'] as string | undefined;
      if (conversationId) {
        void this.router.navigate([ROUTES.conversation(conversationId)]);
      }
    });
  }

  async setPushEnabled(enabled: boolean): Promise<void> {
    localStorage.setItem('notifications_push_enabled', String(enabled));
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    if (enabled) {
      this.registerPush();
    } else {
      try {
        await PushNotifications.removeAllListeners();
        await this.apiClient.delete('/v1/devices/push-token');
      } catch (err) {
        console.error('[PushNotificationService] Failed to remove push token from backend:', err);
      }
    }
  }

  isPushEnabled(): boolean {
    return localStorage.getItem('notifications_push_enabled') !== 'false';
  }

  private registerPush(): void {
    PushNotifications.requestPermissions().then((result) => {
      if (result.receive === 'granted') {
        // Register with Apple / Google to receive push tokens
        void PushNotifications.register();
      }
    });
  }
}
