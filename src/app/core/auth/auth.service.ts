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
import { ApiClientService } from '../infrastructure/api-client.service';
import { TokenRepository } from '../infrastructure/token.repository';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { NotificationService } from '../notification/notification.service';
import { PushNotificationService } from '../notification/push-notification.service';
import { AccountBadgeService } from '../notification/account-badge.service';
import { EmbedPreferencesService } from '../embed/embed-preferences.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { PresenceService } from '../presence/presence.service';
import { BskyPostRepository } from '../bsky-post/bsky-post.repository';
import { LinkPreviewService } from '../link-preview/link-preview.service';
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
  private apiClient       = inject(ApiClientService);
  private tokenRepo       = inject(TokenRepository);
  private secureStorage   = inject(SecureLocalStorageService);
  private msgCache        = inject(MessageCacheService);
  private embedPrefsSvc   = inject(EmbedPreferencesService);
  private injector        = inject(Injector);
  // Lazy-resolved to break circular dependency (NotificationService -> AuthService -> NotificationService)
  private get notifSvc(): NotificationService     { return this.injector.get(NotificationService); }
  private get pushSvc():  PushNotificationService { return this.injector.get(PushNotificationService); }
  private get badgeSvc(): AccountBadgeService     { return this.injector.get(AccountBadgeService); }
  private get receiptsSvc(): ReceiptsService       { return this.injector.get(ReceiptsService); }
  private get presenceSvc(): PresenceService       { return this.injector.get(PresenceService); }
  private get bskyPostRepo(): BskyPostRepository   { return this.injector.get(BskyPostRepository); }
  private get linkPreviewSvc(): LinkPreviewService { return this.injector.get(LinkPreviewService); }

  readonly currentUser     = signal<UserProfile | null>(null);
  readonly currentDevice   = signal<DeviceInfo | null>(null);
  readonly isAuthenticated = signal<boolean>(false);

  private _socketErrorBound  = false;
  private _syncListenersBound = false;
  private _refreshing         = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // In-flight restoreSession(), shared across concurrent callers, keyed by
  // the active DID at call time (forensic audit finding F9). Without this,
  // rootGuard/authGuard (or a notification-driven navigation racing the
  // router's own default initial navigation on cold start) can each
  // independently call restoreSession(), duplicating the HTTP session
  // fetch + MLS bootstrap + socket connect + sync init pipeline at the
  // worst possible time (right after app cold start). Keying by DID (rather
  // than a single shared field) matters specifically for switchAccount():
  // it sets the new active DID, then calls restoreSession() -- an unkeyed
  // single field would hand that caller a still-in-flight restore for the
  // PREVIOUS account instead of starting a fresh one for the new DID.
  private restoreSessionPromises = new Map<string, Promise<boolean>>();
  private refreshSecondaryPromises = new Map<string, Promise<string | null>>();

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
    this.clearAllSingletonCaches();
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

    // The backend can return a different deviceId than requested (e.g. a
    // revoked local id doesn't match its idempotent-reuse filter, so it
    // mints a fresh one) -- persist it so the next login sends the real
    // one instead of silently minting a new device row every time.
    //
    // Must never throw here: authRepo.login() has already succeeded and
    // tokens are already saved above, so a failure in this best-effort
    // reconciliation step must not abort the whole login.
    if (response.device.id !== device.id) {
      try {
        await this.deviceSvc.persist(did, response.device.id);
      } catch (err) {
        console.warn('[AuthService] loginWithOAuthSession: device identity persist failed, continuing', err);
      }
    }

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

    // Embed preference load order: local cache first (instant), then a
    // background PDS refresh. Fire-and-forget -- must not delay navigation.
    await this.embedPrefsSvc.bootstrap();
    void this.embedPrefsSvc.refreshFromPds()
      .catch(err => { if (!environment.production) console.error('[AuthService] login: embed preferences refresh failed', err); });
    void this.provisionSvc.checkAndProvisionOnConnect(response.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] login: checkAndProvisionOnConnect failed', err); });

    await this.syncSvc.initialize(response.user.did, response.device.id, response.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] login: sync initialize failed', err); });

    // If MBK loaded from SecureLocalStorage → navigate to notifications setup or conversations.
    // Otherwise, setupRequired$ or pinRequired$ subscription handles navigation.
    if (this.syncSvc.isMbkAvailable()) {
      if (await this.pushSvc.shouldPromptForPermission()) {
        await this.router.navigate([ROUTES.notificationsSetup]);
      } else {
        await this.router.navigate([ROUTES.conversations]);
      }
    }
  }

  private clearAllSingletonCaches(): void {
    try {
      this.coordinator.clear();
      this.receiptsSvc.clear();
      this.presenceSvc.clear();
      this.bskyPostRepo.clear();
      this.linkPreviewSvc.clear();
    } catch (err) {
      console.warn('[AuthService] failed to clear singleton caches:', err);
    }
  }

  async logout(): Promise<void> {
    this.cancelProactiveRefresh();
    this.syncSvc.reset();
    this.contactsSvc.reset();
    this.clearAllSingletonCaches();

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
      // .catch() alone doesn't protect against this hanging: oauthSvc.logout()
      // calls the external OAuth provider's revoke endpoint (e.g.
      // eurosky.social) with no timeout of its own. A promise that never
      // settles (network stall, unresponsive provider) is not a rejection --
      // .catch() does nothing for it, and it silently blocked every step
      // after it here, including the navigate-to-login at the end (production
      // incident: logout completed server-side (204) but the app never left
      // the current page). Bound it explicitly so a slow/unreachable external
      // provider can never stall local logout.
      await Promise.race([
        this.oauthSvc.logout(did).catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);
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
    // Read the active DID synchronously off setActiveDid()'s own in-memory
    // cache (TokenRepository), not a fresh Preferences round trip -- so a
    // call made right after switchAccount() sets the new DID is guaranteed
    // to key against that new DID, not race a stale read.
    const key = (await this.tokenRepo.getActiveDid()) ?? '__no_active_did__';

    const existing = this.restoreSessionPromises.get(key);
    if (existing) return existing;

    const promise = this.doRestoreSession().finally(() => {
      if (this.restoreSessionPromises.get(key) === promise) {
        this.restoreSessionPromises.delete(key);
      }
    });
    this.restoreSessionPromises.set(key, promise);
    return promise;
  }

  private async doRestoreSession(): Promise<boolean> {
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

    // Reconcile the locally stored deviceId with the server's session device
    // -- restoreSession() never wrote to Preferences before, so a stale local
    // id (e.g. left over from before this device was revoked and re-logged
    // in) would otherwise persist forever and get resent on the next fresh
    // login. See loginWithOAuthSession's identical reconciliation above.
    //
    // Must never throw: restoreSession() runs on every guard-protected
    // navigation (including a plain page refresh) and its callers
    // (auth.guard.ts / root.guard.ts) await it with no try/catch, expecting
    // only true/false. A corrupt/unreadable local device-identity record
    // (validateStoredDeviceIdentity throwing on an unexpected shape) used to
    // only affect fresh logins; reading it here too means it must fail soft.
    try {
      const localDevice = await this.deviceSvc.get(session.user.did);
      if (!localDevice || localDevice.id !== session.device.id) {
        await this.deviceSvc.persist(session.user.did, session.device.id);
      }
    } catch (err) {
      console.warn('[AuthService] restoreSession: device identity reconciliation failed, continuing', err);
    }

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

    await this.embedPrefsSvc.bootstrap();
    void this.embedPrefsSvc.refreshFromPds()
      .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: embed preferences refresh failed', err); });
    void this.provisionSvc.checkAndProvisionOnConnect(session.user, sessionDevice)
      .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: checkAndProvisionOnConnect failed', err); });

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

    // pending-decrypt's IndexedDB is scoped by (did, deviceId) — see F14 — so
    // clearing it needs this device's id, same as the MLS scope clear below.
    try {
      const device = await this.deviceSvc.get(did);
      if (device) {
        await this.pendingDecrypt.clearAllForUser(did, device.id).catch(() => {});
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
    // Nothing stops `did` here from being the CURRENTLY ACTIVE account --
    // PushNotificationService/AccountBadgeService iterate "every linked
    // account" without excluding it. If it is, route through the same
    // shared refresh (ApiClientService.ensureRefresh(), via refreshTokens()
    // above) instead of making an independent, undeduped /auth/refresh call:
    // this method used to do its own thing entirely, so it could still race
    // the unified path with the same one-time-use-token problem those fixes
    // were for -- observed in production as 401s persisting even after that
    // unification, traced to this call site.
    const activeDid = await this.tokenRepo.getActiveDid();
    if (did === activeDid) {
      const refreshed = await this.refreshTokens();
      return refreshed ? this.tokenRepo.getAccessToken(did) : null;
    }

    const existing = this.refreshSecondaryPromises.get(did);
    if (existing) return existing;

    const promise = (async () => {
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
    })().finally(() => {
      this.refreshSecondaryPromises.delete(did);
    });

    this.refreshSecondaryPromises.set(did, promise);
    return promise;
  }

  // Delegates to ApiClientService.ensureRefresh() -- the single shared
  // in-flight refresh promise for the WHOLE app, not just this class.
  // refreshTokens() has two callers here (the proactive timer and the
  // socket's connect_error UNAUTHORIZED handler below), but ApiClientService
  // ALSO independently refreshes reactively whenever any REST call gets a
  // 401. Refresh tokens are one-time-use/rotated on success, so any two of
  // these three triggers racing on the same not-yet-rotated token isn't
  // just wasted work: the loser is rejected "invalid or expired" by the
  // backend (its token was already consumed by the winner) -- observed in
  // production as a repeating refresh-then-401 loop. An earlier fix deduped
  // only the two callers inside this class, which wasn't enough because it
  // still raced independently against ApiClientService's own reactive path.
  // Routing everything through one shared promise in one place is the only
  // way to guarantee at most one /auth/refresh call in flight at a time.
  async refreshTokens(): Promise<boolean> {
    const refreshed = await this.apiClient.ensureRefresh();

    if (refreshed) {
      const token = await this.tokenRepo.getAccessToken();
      if (token) this.scheduleProactiveRefresh(token);
      return true;
    }

    // ApiClientService.ensureRefresh() already cleared tokens and navigated
    // to /login on a genuine (non-transient) failure; run AuthService's own
    // broader cleanup too (MLS state, message cache, MBK, ...), which
    // ApiClientService has no knowledge of.
    if (this.isAuthenticated()) {
      await this.clearSession();
    }
    return false;
  }
}

