import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { OAuthService } from '../../core/auth/oauth.service';

@Component({
  selector: 'app-oauth-callback',
  templateUrl: 'oauth-callback.page.html',
  standalone: true,
  imports: [IonContent, RouterLink],
})
export class OauthCallbackPage implements OnInit {
  private router   = inject(Router);
  private auth     = inject(AuthService);
  private oauthSvc = inject(OAuthService);

  error = '';

  async ngOnInit(): Promise<void> {
    // APP_INITIALIZER already called client.init() which processed the OAuth code.
    // The session (if any) is stored in OAuthService — consuming it here avoids
    // trying to exchange the same code twice (codes are single-use).
    const session = this.oauthSvc.session;
    if (session) {
      try {
        await this.auth.loginWithOAuthSession(session);
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Connexion OAuth échouée.';
      }
      return;
    }

    // Fallback: APP_INITIALIZER didn't run or failed — try processing here.
    // This should not happen in normal operation but provides a safety net.
    const params = new URLSearchParams(window.location.search);
    if (params.has('error')) {
      this.error = params.get('error_description') ?? params.get('error') ?? 'OAuth error';
      return;
    }
    if (params.has('code')) {
      try {
        const fallbackSession = await this.oauthSvc.handleCallback(params);
        await this.auth.loginWithOAuthSession(fallbackSession);
      } catch (err: unknown) {
        this.error = err instanceof Error ? err.message : 'Connexion OAuth échouée.';
      }
    }
  }
}
