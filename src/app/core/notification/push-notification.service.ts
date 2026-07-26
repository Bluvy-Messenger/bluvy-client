import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { ApiClientService } from '../infrastructure/api-client.service';
import { TokenRepository } from '../infrastructure/token.repository';
import { AuthService } from '../auth/auth.service';
import { ROUTES } from '../routes';
import { KeyPackageService } from '../mls/key-package/key-package.service';

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly apiClient = inject(ApiClientService);
  private readonly tokenRepo = inject(TokenRepository);
  private readonly authSvc   = inject(AuthService);
  private readonly router    = inject(Router);
  private readonly kpSvc     = inject(KeyPackageService);

  initialize(): void {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    // Check if user disabled push notifications
    if (!this.isPushEnabled()) {
      return;
    }

    // 1. Request permission and register.
    // Deferred: calling a native plugin's requestPermissions() immediately on
    // cold start can race the Android Capacitor Bridge before it has finished
    // attaching to the activity, crashing the whole app with a
    // NullPointerException in Bridge.getPermissionStates (a known Capacitor
    // bridge-timing issue, not something in our own plugin usage). A short
    // delay lets the bridge finish initializing before the very first native
    // permission call of the app's lifecycle.
    setTimeout(() => this.registerPush(), 1000);

    // 2. Listeners
    PushNotifications.addListener('registration', async (token) => {
      try {
        await this.uploadTokenForAllAccounts(token.value, 'fcm');
      } catch (err) {
        console.error('[PushNotificationService] Failed to upload push token to backend:', err);
      }
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushNotificationService] Registration error:', error);
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('[PushNotificationService] Foreground notification received:', notification);
      const data = notification.data;
      if (data && data['type'] === 'refill_key_packages') {
        const user = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (user && device) {
          void this.kpSvc.ensureKeyPackagePool(user.did, device.id);
        }
      }
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
      const data = notification.notification.data;
      const conversationId = data['conversationId'] as string | undefined;
      if (conversationId) {
        void this.router.navigate([ROUTES.conversation(conversationId)]);
      }
    });
  }

  /**
   * Called by AuthService after every account switch.
   * Re-registers the FCM token with the backend so that push notifications
   * are delivered to the newly active account rather than the previous one.
   */
  async onAccountSwitch(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    if (!this.isPushEnabled()) return;

    // Re-request and re-register: the registration listener will upload the
    // token to the backend, which will now bind it to the current active user.
    this.registerPush();
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
        await this.deleteTokenForAllAccounts();
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

  /**
   * Uploads the OS push token on behalf of every account stored on this
   * device, not just the currently active one. The token is device-level
   * (same value regardless of which account is selected in the UI), but the
   * backend binds it per account (`deviceId` resolved from the bearer
   * token's session) — so every linked account needs its own upload to
   * actually receive pushes while it isn't the one selected in the app.
   * Best-effort per account: a missing access token for a linked account
   * simply skips it; an expired one is refreshed (scoped to that account,
   * see AuthService.refreshTokensForDid) and retried once before giving up.
   */
  private async uploadTokenForAllAccounts(token: string, platform: 'fcm' | 'apns'): Promise<void> {
    const accounts = await this.authSvc.getStoredAccounts();
    await Promise.allSettled(accounts.map(async (acc) => {
      const accessToken = await this.tokenRepo.getAccessToken(acc.did);
      if (!accessToken) return;
      await this.pushTokenRequestWithRefresh(acc.did, accessToken, (bearer) =>
        this.apiClient.post('/v1/devices/push-token', { token, platform }, {
          skipAuth: true,
          headers:  { Authorization: `Bearer ${bearer}` },
        }));
    }));
  }

  /** Mirrors uploadTokenForAllAccounts: removes the token for every linked account. */
  private async deleteTokenForAllAccounts(): Promise<void> {
    const accounts = await this.authSvc.getStoredAccounts();
    await Promise.allSettled(accounts.map(async (acc) => {
      const accessToken = await this.tokenRepo.getAccessToken(acc.did);
      if (!accessToken) return;
      await this.pushTokenRequestWithRefresh(acc.did, accessToken, (bearer) =>
        this.apiClient.delete('/v1/devices/push-token', {
          skipAuth: true,
          headers:  { Authorization: `Bearer ${bearer}` },
        }));
    }));
  }

  // skipAuth + a manually-attached per-account token bypasses
  // ApiClientService's own refresh-on-401 handling (that logic only knows
  // how to refresh the currently active account) — so without this, a
  // linked-but-inactive account's expired token would make every push-token
  // upload/delete for it fail silently and permanently. Refresh that
  // specific account's token and retry once before giving up.
  private async pushTokenRequestWithRefresh(
    did:         string,
    accessToken: string,
    send:        (bearer: string) => Promise<unknown>,
  ): Promise<void> {
    try {
      await send(accessToken);
    } catch (err) {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) return;
      const refreshed = await this.authSvc.refreshTokensForDid(did);
      if (!refreshed) return;
      await send(refreshed).catch(() => {});
    }
  }
}
