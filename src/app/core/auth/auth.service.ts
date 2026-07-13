import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { OAuthSession } from '@atproto/oauth-client-browser';
import { OAuthService } from './oauth.service';
import { DeviceIdentityService } from '../device/device-identity.service';
import type { DeviceInfo } from '../device/device.types';
import { MlsCoordinatorBase } from '../mls/coordinator/mls-coordinator.base';
import { MlsStateStorageService } from '../mls/mls-state-storage.service';
import { PendingDecryptRepository } from '../mls/repositories/pending-decrypt.repository';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { SocketService } from '../infrastructure/socket.service';
import { SyncService } from '../sync/sync.service';
import { ContactsService } from '../contact/contacts.service';
import { AuthRepository } from './auth.repository';
import type { UserProfile, AuthSessionResponse } from './auth.types';
import { TokenRepository } from '../infrastructure/token.repository';
import { SecureLocalStorageService } from '../secure-local-storage/secure-local-storage.service';
import { MessageCacheService } from '../conversation/message-cache.service';
import { ROUTES } from '../routes';

export type { UserProfile } from './auth.types';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private router          = inject(Router);
  private oauthSvc        = inject(OAuthService);
  private deviceSvc       = inject(DeviceIdentityService);
  private coordinator     = inject(MlsCoordinatorBase);
  private mlsStateStorage = inject(MlsStateStorageService);
  private pendingDecrypt  = inject(PendingDecryptRepository);
  private kpSvc           = inject(KeyPackageService);
  private socketSvc       = inject(SocketService);
  private syncSvc         = inject(SyncService);
  private contactsSvc     = inject(ContactsService);
  private authRepo        = inject(AuthRepository);
  private tokenRepo       = inject(TokenRepository);
  private secureStorage   = inject(SecureLocalStorageService);
  private msgCache        = inject(MessageCacheService);

  readonly currentUser     = signal<UserProfile | null>(null);
  readonly currentDevice   = signal<DeviceInfo | null>(null);
  readonly isAuthenticated = signal<boolean>(false);

  private _socketErrorBound  = false;
  private _syncListenersBound = false;
  private _refreshing         = false;

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

    await this.tokenRepo.setAccessToken(response.accessToken);
    await this.tokenRepo.setRefreshToken(response.refreshToken);

    const sessionDevice: DeviceInfo = {
      id:       response.device.id,
      name:     response.device.name,
      platform: response.device.platform,
    };

    this.currentUser.set(response.user);
    this.currentDevice.set(sessionDevice);
    this.isAuthenticated.set(true);

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

    await this.syncSvc.initialize(response.user.did, response.device.id)
      .catch(err => { if (!environment.production) console.error('[AuthService] login: sync initialize failed', err); });

    // If MBK loaded from SecureLocalStorage → navigate to conversations.
    // Otherwise, setupRequired$ or pinRequired$ subscription handles navigation.
    if (this.syncSvc.isMbkAvailable()) {
      await this.router.navigate([ROUTES.conversations]);
    }
  }

  async logout(): Promise<void> {
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
    } else {
      this.oauthSvc.clearSession();
    }

    this.socketSvc.disconnect();
    await this.clearSession();
    await this.router.navigate([ROUTES.login]);
  }

  async restoreSession(): Promise<boolean> {
    const token = await this.tokenRepo.getAccessToken();
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

    // Backend JWT session is confirmed above, but the raw AT-proto OAuth
    // session (needed for direct-to-PDS writes like publishDeclaration) is
    // separate and isn't restored by the APP_INITIALIZER on a plain reload —
    // restore it here so ensureKeyPackagePool()'s syncDeclaration() doesn't
    // fail with "No active ATProto session".
    if (!this.oauthSvc.session) {
      await this.oauthSvc.tryRestore()
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

    await this.syncSvc.initialize(session.user.did, session.device.id)
      .catch(err => { if (!environment.production) console.error('[AuthService] restoreSession: sync initialize failed', err); });

    return true;
  }

  async clearSession(): Promise<void> {
    const userDid = this.currentUser()?.did ?? null;

    await this.tokenRepo.clearTokens();
    this.currentUser.set(null);
    this.currentDevice.set(null);
    this.isAuthenticated.set(false);

    if (userDid) {
      await this.secureStorage.clearMbk(userDid).catch(() => {});
    }
    await this.msgCache.clearAll().catch(() => {});
    await this.mlsStateStorage.clearAll().catch(() => {});
    await this.pendingDecrypt.clearAll().catch(() => {});
  }

  async refreshTokens(): Promise<boolean> {
    const refreshToken = await this.tokenRepo.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const tokens = await this.authRepo.refresh(refreshToken);
      await this.tokenRepo.setAccessToken(tokens.accessToken);
      await this.tokenRepo.setRefreshToken(tokens.refreshToken);
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
