import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ApiClientService } from '../../core/infrastructure/api-client.service';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { OAuthService } from '../../core/auth/oauth.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-login',
  templateUrl: 'login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
})
export class LoginPage implements OnInit {
  private router   = inject(Router);
  private auth     = inject(AuthService);
  private oauthSvc = inject(OAuthService);
  private i18n     = inject(TranslationService);
  private apiClient = inject(ApiClientService);

  handle   = '';
  loading  = false;
  checking = true;
  error    = '';

  async ngOnInit(): Promise<void> {
    const cached = sessionStorage.getItem('bluvy_invite_context');
    if (cached) {
      try {
        const context = JSON.parse(cached);
        if (context.viewerDid) {
          const url = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(context.viewerDid)}`;
          this.apiClient.get<any>(url, { skipAuth: true }).then(profile => {
            if (profile?.handle) {
              this.handle = profile.handle;
            }
          }).catch(() => {});
        }
      } catch {}
    }

    const isAddingAccount = sessionStorage.getItem('add_account_mode') === 'true';

    if (this.auth.isAuthenticated() && !isAddingAccount) {
      await this.router.navigate([ROUTES.conversations]);
      return;
    }

    // APP_INITIALIZER may have stored a pending OAuth session (callback or restore).
    // Consume it before falling back to the backend session restore.
    const oauthSession = this.oauthSvc.session ?? (isAddingAccount ? null : await this.oauthSvc.tryRestore());
    if (oauthSession) {
      try {
        await this.auth.loginWithOAuthSession(oauthSession);
        sessionStorage.removeItem('add_account_mode');
        return;
      } catch {
        // Session invalid; fall through to backend session restore.
      }
    }

    if (isAddingAccount) {
      this.checking = false;
      return;
    }

    try {
      const restored = await this.auth.restoreSession();
      if (restored) {
        await this.router.navigate([ROUTES.conversations]);
      }
    } finally {
      this.checking = false;
    }
  }

  async onLogin(): Promise<void> {
    const handle = this.handle.trim();

    if (!handle) {
      this.error = this.i18n.t('login.error.required');
      return;
    }

    this.loading = true;
    this.error   = '';

    try {
      console.log('[LoginPage] calling signIn');
      await this.oauthSvc.signIn(handle);
      console.log('[LoginPage] signIn completed, session:', !!this.oauthSvc.session);
      const session = this.oauthSvc.session;
      if (session) {
        console.log('[LoginPage] calling loginWithOAuthSession');
        await this.auth.loginWithOAuthSession(session);
        sessionStorage.removeItem('add_account_mode');
        console.log('[LoginPage] loginWithOAuthSession completed');
      } else {
        console.log('[LoginPage] session is null');
        this.loading = false;
      }
    } catch (err: unknown) {
      console.error('[LoginPage] error during login:', err);
      this.error = this.extractError(err);
      this.loading = false;
    }
  }

  openCreateAccount(): void {
    window.open('https://bsky.app', '_blank', 'noopener,noreferrer');
  }

  openLegal(path: string): void {
    void this.router.navigate([path]);
  }

  private extractError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return this.i18n.t('login.error.failed');
  }
}
