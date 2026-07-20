import { Injectable, inject, signal, effect, Injector, NgZone } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { PushNotifications } from '@capacitor/push-notifications';
import { ApiClientService } from '../infrastructure/api-client.service';
import { SocketService } from '../infrastructure/socket.service';
import { ConnectivityService } from '../infrastructure/connectivity.service';
import { TokenRepository } from '../infrastructure/token.repository';
import { AuthService, StoredAccount } from '../auth/auth.service';

interface ConversationPage {
  data: { id: string; unreadCount: number }[];
}

@Injectable({ providedIn: 'root' })
export class AccountBadgeService {
  private readonly tokenRepo    = inject(TokenRepository);
  private readonly authSvc      = inject(AuthService);
  private readonly api          = inject(ApiClientService);
  private readonly socketSvc    = inject(SocketService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly zone         = inject(NgZone);
  private readonly injector     = inject(Injector);

  /** Map of DID → has unread messages */
  readonly badges = signal<Record<string, boolean>>({});

  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 15_000; // 15 seconds

  /** In-flight refresh, reused so overlapping triggers don't fire duplicate request batches. */
  private refreshing: Promise<void> | null = null;

  /**
   * Starts automatic background listeners so the badge stays current anywhere
   * in the app, not just when the menu page is opened:
   * - Periodic polling every 15s (paused when app is backgrounded)
   * - App foreground: immediate refresh + resume polling
   * - App background: pause polling to save resources
   * - Active-account socket reconnect: immediate refresh
   * - Network back online: immediate refresh
   * - Push received (native only): immediate refresh
   */
  initListeners(): void {
    // Immediate first refresh so the badge is populated on app start
    void this.refresh();

    // Start polling immediately
    this.startPolling();

    // Foreground/background: pause or resume the interval
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void this.refresh();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    // The active account's socket reconnecting is a good time to also check
    // inactive accounts, since it usually follows a network/app resume event.
    this.socketSvc.reconnect$.subscribe(() => void this.refresh());

    // Network coming back online.
    effect(() => {
      if (this.connectivity.online()) void this.refresh();
    }, { injector: this.injector });

    // Push received in foreground: a push arriving may be for an inactive account
    if (Capacitor.isNativePlatform()) {
      void PushNotifications.addListener('pushNotificationReceived', () => {
        void this.refresh();
      });
    }
  }

  private startPolling(): void {
    this.stopPolling(); // Avoid duplicate intervals
    // Run inside Angular zone so signal changes trigger global change detection
    this.pollingInterval = this.zone.runOutsideAngular(() =>
      setInterval(() => {
        this.zone.run(() => void this.refresh());
      }, this.POLL_INTERVAL_MS)
    );
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Fetches unread counts for all inactive accounts and updates the badge map.
   * Safe to call from multiple triggers at once — concurrent calls reuse the
   * same in-flight request batch instead of firing duplicate requests.
   */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const activeDid  = this.authSvc.currentUser()?.did ?? null;
    const allAccounts: StoredAccount[] = await this.authSvc.getStoredAccounts();
    const inactive   = allAccounts.filter(a => a.did !== activeDid);

    if (inactive.length === 0) {
      this.badges.set({});
      return;
    }

    const results = await Promise.allSettled(
      inactive.map(acc => this.fetchHasUnread(acc.did))
    );

    const updated: Record<string, boolean> = { ...this.badges() };
    inactive.forEach((acc, i) => {
      const result = results[i];
      if (result?.status === 'fulfilled') {
        updated[acc.did] = result.value;
      }
      // On failure, keep the previous badge state (don't clear it)
    });

    this.badges.set(updated);
  }

  /** Clears the badge for a specific account (called when switching to it). */
  clearBadge(did: string): void {
    const current = { ...this.badges() };
    delete current[did];
    this.badges.set(current);
  }

  /** Returns true if the given account has at least one unread message. */
  hasBadge(did: string): boolean {
    return this.badges()[did] === true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchHasUnread(did: string): Promise<boolean> {
    const token = await this.tokenRepo.getAccessToken(did);
    if (!token) return false;

    try {
      // skipAuth + manual Authorization header: this fetches on behalf of an
      // inactive account, whose token is not the one ApiClientService would
      // otherwise attach automatically (the active account's token).
      const page = await this.api.get<ConversationPage>('/v1/conversations?limit=20', {
        skipAuth: true,
        headers:  { Authorization: `Bearer ${token}` },
      });
      return Array.isArray(page?.data) && page.data.some(c => (c.unreadCount ?? 0) > 0);
    } catch {
      return false;
    }
  }
}
