import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { OAuthService } from '../../core/auth/oauth.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';

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

  handle   = '';
  loading  = false;
  checking = true;
  error    = '';

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      await this.router.navigate(['/tabs/conversations']);
      return;
    }

    // APP_INITIALIZER may have stored a pending OAuth session (callback or restore).
    // Consume it before falling back to the backend session restore.
    const oauthSession = this.oauthSvc.session ?? await this.oauthSvc.tryRestore();
    if (oauthSession) {
      try {
        await this.auth.loginWithOAuthSession(oauthSession);
        return;
      } catch {
        // Session invalid; fall through to backend session restore.
      }
    }

    try {
      const restored = await this.auth.restoreSession();
      if (restored) {
        await this.router.navigate(['/tabs/conversations']);
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
      await this.oauthSvc.signIn(handle);
      // On web: the page redirects — execution stops here.
      // On native: signIn() awaits the App Link callback internally.
    } catch (err: unknown) {
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
