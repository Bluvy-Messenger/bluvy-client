import { Injectable, inject, signal } from '@angular/core';
import { OAuthService } from '../auth/oauth.service';
import { AtprotoRepoService } from '../auth/atproto-repo.service';
import { KeyPackageService } from '../mls/key-package/key-package.service';
import { BadgeVisibilityCacheRepository } from './badge-visibility-cache.repository';
import {
  BADGE_VISIBILITY_OPTIONS,
  DEFAULT_BADGE_VISIBILITY,
  type BadgeVisibility,
} from './badge-visibility.types';

function normalize(value: string | undefined): BadgeVisibility {
  return (BADGE_VISIBILITY_OPTIONS as string[]).includes(value ?? '')
    ? (value as BadgeVisibility)
    : DEFAULT_BADGE_VISIBILITY;
}

@Injectable({ providedIn: 'root' })
export class BadgeVisibilityService {
  private oauth = inject(OAuthService);
  private repo  = inject(AtprotoRepoService);
  private kpSvc = inject(KeyPackageService);
  private cache = inject(BadgeVisibilityCacheRepository);

  readonly showButtonTo = signal<BadgeVisibility>(DEFAULT_BADGE_VISIBILITY);
  readonly saving = signal(false);

  /**
   * Fast, local-only load -- must never block on network. Takes `did`
   * explicitly (from AuthService.currentUser(), the backend-session identity)
   * rather than reading OAuthService.session -- the raw ATProto OAuth session
   * is a separate, independently-expiring credential only needed later for
   * the actual PDS write, and requiring it here would make a page that's
   * purely "show my saved preference" fail whenever that OAuth session
   * hasn't been restored yet, even though the user is clearly logged in.
   */
  async bootstrap(did: string): Promise<void> {
    const cached = await this.cache.getCached(did);
    if (cached) this.showButtonTo.set(cached);
  }

  /** Background refresh from the user's PDS -- fire-and-forget from callers. */
  async refreshFromPds(did: string): Promise<void> {
    await this.oauth.ensureSession(did);

    const record = await this.repo.getDeclaration();
    if (!record) return; // no declaration yet, ATProto session not ready, or PDS unreachable -- keep local value

    const value = normalize(record.messageMe?.showButtonTo);
    this.showButtonTo.set(value);
    await this.cache.setCached(did, value);
  }

  /**
   * Persists the visibility choice locally (always, regardless of ATProto
   * OAuth session state) and best-effort republishes the com.bluvy.declaration
   * record immediately. The PDS write needs OAuthService's ATProto session
   * (independent from -- and can lag behind -- the app's own backend login
   * session), so it's allowed to fail silently here: if it's not restorable
   * right now, or no device MLS key exists yet, the cached preference is
   * still picked up by the next KeyPackageService.syncDeclaration() call
   * (on next app launch, or within its 1h verification window).
   */
  async setShowButtonTo(value: BadgeVisibility, did: string, deviceId?: string): Promise<void> {
    this.showButtonTo.set(value); // instant UI feedback
    await this.cache.setCached(did, value);

    if (!deviceId) return;

    this.saving.set(true);
    try {
      const session = await this.oauth.ensureSession(did);
      if (!session) return;

      const signatureKey = await this.kpSvc.getCurrentSignatureKey(did, deviceId);
      if (signatureKey) {
        await this.repo.publishDeclaration(signatureKey, value);
      }
    } catch {
      // Best-effort immediate publish only -- syncDeclaration() will retry.
    } finally {
      this.saving.set(false);
    }
  }
}
