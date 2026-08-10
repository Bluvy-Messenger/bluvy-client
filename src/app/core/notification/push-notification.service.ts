import { Injectable, Injector, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { NavController } from '@ionic/angular/standalone';
import { ApiClientService } from '../infrastructure/api-client.service';
import { TokenRepository } from '../infrastructure/token.repository';
import { AuthService } from '../auth/auth.service';
import { ROUTES } from '../routes';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { AppPreferencesSyncService } from '../services/app-preferences-sync.service';

@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly injector  = inject(Injector);
  private readonly apiClient = inject(ApiClientService);
  private readonly tokenRepo = inject(TokenRepository);
  private readonly authSvc   = inject(AuthService);
  private readonly navCtrl   = inject(NavController);
  private readonly kpSvc     = inject(KeyPackageService);

  async initialize(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    // Check if user disabled push notifications
    if (!this.isPushEnabled()) {
      return;
    }

    // Register listeners first
    this.setupListeners();

    // If permission was already granted previously, automatically register for FCM/APNS token
    try {
      const status = await PushNotifications.checkPermissions();
      if (status.receive === 'granted') {
        void PushNotifications.register();
      }
    } catch (err) {
      console.warn('[PushNotificationService] Error checking permissions during init:', err);
    }
  }

  private setupListeners(): void {
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
        void this.openConversationFromNotification(conversationId);
      }
    });
  }

  // Notification taps can arrive on a cold start, racing the router's own
  // default initial navigation (both hit rootGuard/authGuard's
  // restoreSession() call — now deduped, see AuthService.restoreSession).
  // Wait for auth before navigating, then always seed the stack with the
  // conversation list underneath the opened conversation (navigateRoot +
  // navigateForward instead of a single push) so back-button behavior is
  // consistent regardless of whether the app was cold or already running.
  private async openConversationFromNotification(conversationId: string): Promise<void> {
    if (!this.authSvc.isAuthenticated()) {
      const restored = await this.authSvc.restoreSession();
      if (!restored) return;
    }
    await this.navCtrl.navigateRoot([ROUTES.conversations], { animated: false });
    await this.navCtrl.navigateForward([ROUTES.conversation(conversationId)]);
  }

  /**
   * Returns true if we should present the post-login notification permission page to the user.
   */
  async shouldPromptForPermission(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    if (!this.isPushEnabled()) return false;
    if (localStorage.getItem('push_permission_prompted') === 'true') return false;

    try {
      const status = await PushNotifications.checkPermissions();
      return status.receive === 'prompt' || status.receive === 'prompt-with-rationale';
    } catch {
      return false;
    }
  }

  /**
   * Triggers native permission request dialog after user consents on the dedicated onboarding page.
   */
  async requestPermissionsFromUser(): Promise<boolean> {
    localStorage.setItem('push_permission_prompted', 'true');
    if (!Capacitor.isNativePlatform()) return false;

    try {
      const result = await PushNotifications.requestPermissions();
      if (result.receive === 'granted') {
        void PushNotifications.register();
        return true;
      }
    } catch (err) {
      console.error('[PushNotificationService] Failed to request permissions:', err);
    }
    return false;
  }

  /** Mark that the user skipped or saw the permission prompt without asking system again */
  markPermissionPrompted(): void {
    localStorage.setItem('push_permission_prompted', 'true');
  }

  /**
   * Called by AuthService after every account switch.
   * Re-registers the FCM token with the backend so that push notifications
   * are delivered to the newly active account rather than the previous one.
   */
  async onAccountSwitch(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    if (!this.isPushEnabled()) return;

    const status = await PushNotifications.checkPermissions();
    if (status.receive === 'granted') {
      void PushNotifications.register();
    }
  }

  async setPushEnabled(enabled: boolean): Promise<void> {
    localStorage.setItem('notifications_push_enabled', String(enabled));
    try { this.injector.get(AppPreferencesSyncService).scheduleSave(); } catch { /* ignore */ }
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    if (enabled) {
      void this.requestPermissionsFromUser();
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

  setPushNotificationsEnabled(enabled: boolean): void {
    void this.setPushEnabled(enabled);
  }

  isPushNotificationsEnabled(): boolean {
    return this.isPushEnabled();
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
