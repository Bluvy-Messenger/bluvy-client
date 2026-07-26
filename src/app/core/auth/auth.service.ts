import { Injectable, inject, signal, Injector } from '@angular/core';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { environment } from '../../../environments/environment';
import { OAuthSession } from '@atproto/oauth-client-browser';
import { OAuthService } from './oauth.service';
import { DeviceIdentityService } from '../device/device-identity.service';
import type { DeviceInfo } from '../device/device.types';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { MlsStateStorageService } from '../mls/mls-state-storage.service';
import { PendingDecryptRepository } from '../mls/repositories/pending-decrypt.repository';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { DeviceProvisioningService } from '../device/device-provisioning.service';
import { SocketService } from '../infrastructure/socket.service';
import { SyncService } from '../sync/sync.service';
import { ContactsService } from '../contact/contacts.service';
import { AuthRepository } from './auth.repository';
import type { UserProfile, AuthSessionResponse } from './auth.types';
import { TokenRepository } from '../infrastructure/token.repository';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { NotificationService } from '../notification/notification.service';
import { PushNotificationService } from '../notification/push-notification.service';
import { AccountBadgeService } from '../notification/account-badge.service';
import { ROUTES } from '../routes';

export type { UserProfile } from './auth.types';

export interface StoredAccount {
  did: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private router          = inject(Router);
  private oauthSvc        = inject(OAuthService);
  private deviceSvc       = inject(DeviceIdentityService);
  private coordinator     = inject(MlsCoordinatorBase);
  private mlsStateStorage = inject(MlsStateStorageService);
  private pendingDecrypt  = inject(PendingDecryptRepository);
  private kpSvc           = inject(KeyPackageService);
  private provisionSvc    = inject(DeviceProvisioningService);
  private socketSvc       = inject(SocketService);
  private syncSvc         = inject(SyncService);
  private contactsSvc     = inject(ContactsService);
  private authRepo        = inject(AuthRepository);
  private tokenRepo       = inject(TokenRepository);
  private secureStorage   = inject(SecureLocalStorageService);
  private msgCache        = inject(MessageCacheService);
  private injector        = inject(Injector);
  // Lazy-resolved to break circular dependency (NotificationService -> AuthService -> NotificationService)
  private get notifSvc(): NotificationService     { return this.injector.get(NotificationService); }
  private get pushSvc():  PushNotificationService { return this.injector.get(PushNotificationService); }
  private get badgeSvc(): AccountBadgeService     { return this.injector.get(AccountBadgeService); }

  readonly currentUser     = signal<UserProfile | null>(null);
  readonly currentDevice   = signal<DeviceInfo | null>(null);
  readonly isAuthenticated = signal<boolean>(false);

  private _socketErrorBound  = false;
  private _syncListenersBound = false;
  private _refreshing         = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Decodes the (unverified — verification is the server's job, this is only
  // used to schedule a client-side timer) `exp` claim of a JWT access token.
  private decodeJwtExp(token: string): number | null {
    try {
      const payloadB64 = token.split('.')[1];
      if (!payloadB64) return null;
      const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const payload = JSON.parse(atob(padded)) as { exp?: number };
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  // Refreshes the access token shortly before it actually expires, so the
  // reactive 401-then-retry path in ApiClientService rarely fires in
  // practice. Purely additive: that reactive path stays as the safety net
  // for whenever this timer doesn't run (app was backgrounded/killed, clock
  // skew, etc.) — it is not replaced.
  private scheduleProactiveRefresh(accessToken: string): void {
    this.cancelProactiveRefresh();
    const exp = this.decodeJwtExp(accessToken);
    if (!exp) return;

    const marginMs = 60_000; // refresh 1 minute before actual expiry
    const delay = Math.max(1_000, exp * 1000 - Date.now() - marginMs);

    this.refreshTimer = setTimeout(() => { void this.refreshTokens(); }, delay);
  }

  private cancelProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Retries a critical MLS bootstrap step with backoff before giving up.
  // Used so login/session-restore only proceed once the MLS connection is
  // actually confirmed, instead of silently continuing on a swallowed error.
  private async retryMlsBootstrap<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const delays = [500, 1500, 3000]; // ms between attempts — 4 tries total
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= delays.length) throw err;
        if (!environment.production) console.error(`[AuthService] ${label} failed (attempt ${attempt + 1}), retrying`, err);
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
  }

  private startSocket(): void {
    if (!this._socketErrorBound) {
      this._socketErrorBound = true;
      this.socketSvc.connectError$.subscribe(async (err) => {
        if (err.message !== 'UNAUTHORIZED') return;
        if (!this.isAuthenticated()) return;
        if (this._refreshing) return;
        this._refreshing = true;
        try {
          const refreshed = await this.refreshTokens();
          if (!refreshed && !this.isAuthenticated()) {
            this.socketSvc.disconnect();
            if (!this.router.url.startsWith(ROUTES.login)) {
              await this.router.navigate([ROUTES.login]);
            }
          }
        } finally {
          this._refreshing = false;
        }
      });
    }
    this.socketSvc.connect();
  }

  // Binds sync navigation once. Subjects only emit during initialize() so these
  // subscriptions are safe to keep alive for the entire session.
  private bindSyncListeners(): void {
    if (this._syncListenersBound) return;
    this._syncListenersBound = true;
    this.syncSvc.setupRequired$.subscribe(() => {
      void this.router.navigate([ROUTES.setupSync]);
    });
    this.syncSvc.pinRequired$.subscribe(() => {
      void this.router.navigate([ROUTES.pinUnlock]);
    });
    this.syncSvc.migrationRequired$.subscribe(() => {
      void this.router.navigate([ROUTES.migrateSync]);
    });
  }

  // ── Multi-Account Management ───────────────────────────────────────────────

  async getStoredAccounts(): Promise<StoredAccount[]> {
    const { value } = await Preferences.get({ key: 'auth.accounts' });
    if (!value) return [];
    try {
      return JSON.parse(value) as StoredAccount[];
    } catch {
      return [];
    }
  }

  async saveStoredAccounts(accounts: StoredAccount[]): Promise<void> {
    await Preferences.set({ key: 'auth.accounts', value: JSON.stringify(accounts) });
  }

  async addOrUpdateAccount(account: StoredAccount): Promise<void> {
    const accounts = await this.getStoredAccounts();
    const index = accounts.findIndex(a => a.did === account.did);
    if (index >= 0) {
      accounts[index] = account;
    } else {
      accounts.push(account);
    }
    await this.saveStoredAccounts(accounts);
  }

  async removeAccount(did: string): Promise<void> {
    let accounts = await this.getStoredAccounts();
    accounts = accounts.filter(a => a.did !== did);
    await this.saveStoredAccounts(accounts);
  }

  async switchAccount(did: string): Promise<boolean> {
    console.log('[AuthService] switchAccount starting for DID:', did);
    
    // 1. Disconnect current socket
    this.socketSvc.disconnect();
    
    // 2. Clear in-memory active states + close any visible notification toast
    this.syncSvc.reset();
    this.contactsSvc.reset();
    this.notifSvc.onAccountSwitch();
    this.badgeSvc.clearBadge(did); // Clear the unread badge for the account we're switching TO
    await this.pushSvc.onAccountSwitch();
    
    // 3. Set the active DID
    await this.tokenRepo.setActiveDid(did);
    
    // 4. Try to restore session for the new active DID
    const success = await this.restoreSession();
    
    if (success) {
      await this.router.navigate([ROUTES.conversations]);
      return true;
    } else {
      console.error('[AuthService] switchAccount: restoreSession failed for DID:', did);
      await this.removeAccount(did);
      
      const accounts = await this.getStoredAccounts();
      if (accounts.length > 0) {
        return this.switchAccount(accounts[0].did);
      } else {
        await this.tokenRepo.setActiveDid(null);
        this.currentUser.set(null);
        this.currentDevice.set(null);
        this.isAuthenticated.set(false);
        await this.router.navigate([ROUTES.login]);
        return false;
      }
    }
  }

  async prepareForAddAccount(): Promise<void> {
    sessionStorage.setItem('add_account_mode', 'true');
    this.currentUser.set(null);
    this.currentDevice.set(null);
    this.isAuthenticated.set(false);
    this.socketSvc.disconnect();
    this.oauthSvc.clearSession();
    await this.router.navigate([ROUTES.login]);
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  async loginWithOAuthSession(session: OAuthSession): Promise<void> {
    console.log('[AuthService] loginWithOAuthSession start');
    const did = session.did;
    console.log('[AuthService] did:', did);
    console.log('[AuthService] fetching service auth token...');
    const serviceAuthToken = await this.oauthSvc.getServiceAuthToken(session, environment.oauthServiceDid);
    console.log('[AuthService] service auth token fetched successfully');
    console.log('[AuthService] loading device info...');
    const device = await this.deviceSvc.getOrCreate(did);
    console.log('[AuthService] device:', device);

    console.log('[AuthService] calling authRepo.login...');
    const response = await this.authRepo.login(
      serviceAuthToken,
      did,
      device.id,
      device.name,
      device.platform,
    );

    // Save tokens scoped by DID and set active DID
    await this.tokenRepo.setActiveDid(response.user.did);
    await this.tokenRepo.setAccessToken(response.accessToken, response.user.did);
    await this.tokenRepo.setRefreshToken(response.refreshToken, response.user.did);
    this.scheduleProactiveRefresh(response.accessToken);

    // Save/update account in the list
    await this.addOrUpdateAccount({
      did: response.user.did,
      handle: response.user.handle,
      displayName: response.user.displayName,
      avatarUrl: response.user.avatarUrl,
    });

    const sessionDevice: DeviceInfo = {
      id:       response.device.id,
      name:     response.device.name,
      platform: response.device.platform,
    };

    this.currentUser.set(response.user);
    this.currentDevice.set(sessionDevice);
    this.isAuthenticated.set(true);
    sessionStorage.removeItem('add_account_mode');

    // Re-trigger push token registration so this newly added/logged-in account
    // gets its own push-token row immediately, instead of waiting for the next
    // cold start or a manual switch away and back.
    void this.pushSvc.onAccountSwitch();

    try {
      await this.retryMlsBootstrap('login: initializeForSession', () =>
        this.coordinator.initializeForSession(response.user, sessionDevice));
      await this.retryMlsBootstrap('login: ensureKeyPackagePool', () =>
        this.kpSvc.ensureKeyPackagePool(response.user.did, sessionDevice.id));
    } catch (err) {
      this.currentUser.set(null);
      this.currentDevice.set(null);
      this.isAuthenticated.set(false);
      throw err;
    }

    this.startSocket();
    this.bindSyncListeners();

    // Phase 6 (proactive recovery sweep, see MLS_FINAL_IMPLEMENTATION_PLAN.md):
    // catch up any conversation that fell behind before the applyCommit/catch-up
    // fixes shipped, instead of waiting for the user to reopen it organically.
    // Fire-and-forget -- must not delay login/navigation.
    void this.provisionSvc.proactiveCatchUpSweep(response.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] login: proactiveCatchUpSweep failed', err); });

    await this.syncSvc.initialize(response.user.did, response.device.id, response.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] login: sync initialize failed', err); });

    // If MBK loaded from SecureLocalStorage → navigate to conversations.
    // Otherwise, setupRequired$ or pinRequired$ subscription handles navigation.
    if (this.syncSvc.isMbkAvailable()) {
      await this.router.navigate([ROUTES.conversations]);
    }
  }

  async logout(): Promise<void> {
    this.cancelProactiveRefresh();
    this.syncSvc.reset();
    this.contactsSvc.reset();

    const did = this.currentUser()?.did ?? null;

    try {
      const token = await this.tokenRepo.getAccessToken();
      if (token) {
        await this.authRepo.logout();
      }
    } catch {
      // Clear local state regardless of server response.
    }

    if (did) {
      await this.oauthSvc.logout(did).catch(() => {});
      await this.removeAccount(did);
      await this.tokenRepo.clearTokens(did);
      await this.clearSessionForDid(did);
    } else {
      this.oauthSvc.clearSession();
      await this.tokenRepo.clearTokens();
    }

    this.socketSvc.disconnect();

    // Check if there are other logged-in accounts
    const accounts = await this.getStoredAccounts();
    if (accounts.length > 0) {
      await this.switchAccount(accounts[0].did);
    } else {
      await this.tokenRepo.setActiveDid(null);
      this.currentUser.set(null);
      this.currentDevice.set(null);
      this.isAuthenticated.set(false);
      await this.router.navigate([ROUTES.login]);
    }
  }

  async restoreSession(): Promise<boolean> {
    if (sessionStorage.getItem('add_account_mode') === 'true') {
      return false;
    }
    let activeDid = await this.tokenRepo.getActiveDid();
    
    // Check if we have legacy tokens
    const legacyAccessVal = await Preferences.get({ key: 'auth.accessToken' });
    const legacyRefreshVal = await Preferences.get({ key: 'auth.refreshToken' });
    const hasLegacyTokens = !!(legacyAccessVal.value || legacyRefreshVal.value);
    
    const token = await this.tokenRepo.getAccessToken(activeDid || undefined);
    if (!token) return false;

    let session: AuthSessionResponse;
    try {
      session = await this.authRepo.getSession();
    } catch {
      return false;
    }

    const sessionDevice: DeviceInfo = {
      id:       session.device.id,
      name:     session.device.name,
      platform: session.device.platform,
    };

    this.currentUser.set(session.user);
    this.currentDevice.set(sessionDevice);
    this.isAuthenticated.set(true);
    this.scheduleProactiveRefresh(token);

    // Migrate legacy single account if needed
    if (!activeDid && hasLegacyTokens) {
      activeDid = session.user.did;
      await this.tokenRepo.setActiveDid(activeDid);
      if (legacyAccessVal.value) {
        await this.tokenRepo.setAccessToken(legacyAccessVal.value, activeDid);
        await Preferences.remove({ key: 'auth.accessToken' });
      }
      if (legacyRefreshVal.value) {
        await this.tokenRepo.setRefreshToken(legacyRefreshVal.value, activeDid);
        await Preferences.remove({ key: 'auth.refreshToken' });
      }
    }

    // Save/update account in the list
    await this.addOrUpdateAccount({
      did: session.user.did,
      handle: session.user.handle,
      displayName: session.user.displayName,
      avatarUrl: session.user.avatarUrl,
    });

    if (!this.oauthSvc.session) {
      await this.oauthSvc.tryRestore(activeDid || undefined)
        .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: tryRestore failed', err); });
    }

    try {
      await this.retryMlsBootstrap('restoreSession: initializeForSession', () =>
        this.coordinator.initializeForSession(session.user, sessionDevice));
      await this.retryMlsBootstrap('restoreSession: ensureKeyPackagePool', () =>
        this.kpSvc.ensureKeyPackagePool(session.user.did, sessionDevice.id));
    } catch (err) {
      if (!environment.production) console.error('[AuthService] restoreSession: MLS bootstrap failed after retries', err);
      this.currentUser.set(null);
      this.currentDevice.set(null);
      this.isAuthenticated.set(false);
      return false;
    }

    this.startSocket();
    this.bindSyncListeners();

    // Phase 6 (proactive recovery sweep, see MLS_FINAL_IMPLEMENTATION_PLAN.md):
    // same as login() -- catch up any conversation that fell behind before the
    // applyCommit/catch-up fixes shipped. Fire-and-forget.
    void this.provisionSvc.proactiveCatchUpSweep(session.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: proactiveCatchUpSweep failed', err); });

    await this.syncSvc.initialize(session.user.did, session.device.id, session.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: sync initialize failed', err); });

    return true;
  }

  async clearSession(): Promise<void> {
    this.cancelProactiveRefresh();
    const userDid = this.currentUser()?.did ?? null;

    await this.tokenRepo.clearTokens();
    this.currentUser.set(null);
    this.currentDevice.set(null);
    this.isAuthenticated.set(false);

    if (userDid) {
      await this.clearSessionForDid(userDid);
    } else {
      await this.msgCache.clearAll().catch(() => {});
      await this.mlsStateStorage.clearAll().catch(() => {});
      await this.pendingDecrypt.clearAll().catch(() => {});
    }
  }

  async clearSessionForDid(did: string): Promise<void> {
    await this.secureStorage.clearMbk(did).catch(() => {});
    
    // Clear user-specific databases
    await this.msgCache.clearAllForUser(did).catch(() => {});
    await this.pendingDecrypt.clearAllForUser(did).catch(() => {});

    // Clear MLS states for all devices of this user
    try {
      const device = await this.deviceSvc.get(did);
      if (device) {
        await this.mlsStateStorage.clearForScope(`mls:${did}:${device.id}`).catch(() => {});
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Refreshes the access token for an arbitrary, possibly-inactive account,
   * scoped by did — unlike refreshTokens()/scheduleProactiveRefresh(), which
   * only ever track the currently active account. Used by services that act
   * on behalf of every linked account regardless of which one is selected
   * (AccountBadgeService, PushNotificationService): their calls use
   * `skipAuth: true` with a manually-attached per-account token, which
   * deliberately bypasses ApiClientService's own refresh-on-401 handling
   * (that logic only knows how to refresh the active account). Without this,
   * an inactive account's token simply stops working, silently, forever,
   * once it expires.
   */
  async refreshTokensForDid(did: string): Promise<string | null> {
    const refreshToken = await this.tokenRepo.getRefreshToken(did);
    if (!refreshToken) return null;

    try {
      const tokens = await this.authRepo.refresh(refreshToken);
      await this.tokenRepo.setAccessToken(tokens.accessToken, did);
      await this.tokenRepo.setRefreshToken(tokens.refreshToken, did);
      return tokens.accessToken;
    } catch {
      return null;
    }
  }

  async refreshTokens(): Promise<boolean> {
    const activeDid = await this.tokenRepo.getActiveDid();
    const refreshToken = await this.tokenRepo.getRefreshToken(activeDid || undefined);
    if (!refreshToken) return false;

    try {
      const tokens = await this.authRepo.refresh(refreshToken);
      await this.tokenRepo.setAccessToken(tokens.accessToken, activeDid || undefined);
      await this.tokenRepo.setRefreshToken(tokens.refreshToken, activeDid || undefined);
      this.scheduleProactiveRefresh(tokens.accessToken);
      return true;
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) {
        await this.clearSession();
      }
      return false;
    }
  }
}

