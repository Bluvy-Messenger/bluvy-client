import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AuthService } from '../../core/auth/auth.service';
import { OAuthService } from '../../core/auth/oauth.service';
import { SeoService } from '../../core/services/seo.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TranslationService } from '../../core/i18n/translation.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [IonContent, IonIcon, RouterLink, TranslatePipe],
  templateUrl: './landing.page.html',
  styleUrls: ['./landing.page.scss'],
})
export class LandingPage implements OnInit {
  private router   = inject(Router);
  private auth     = inject(AuthService);
  private oauthSvc = inject(OAuthService);
  private seo      = inject(SeoService);
  protected i18n   = inject(TranslationService);

  async ngOnInit(): Promise<void> {
    this.seo.set({
      title:         'Bluvy Messenger',
      description:   'La messagerie privée construite sur Bluesky. Chiffrement de bout en bout MLS, vos clés, votre contrôle. Gratuit sur Web, Android et iOS.',
      canonicalPath: ROUTES.welcome,
    });

    if (this.auth.isAuthenticated()) {
      await this.router.navigate([ROUTES.messages]);
      return;
    }
    // Dev loopback: APP_INITIALIZER stored an OAuth session from the hash callback.
    if (this.oauthSvc.session) {
      await this.router.navigate([ROUTES.login]);
      return;
    }
    if (Capacitor.isNativePlatform()) {
      await this.router.navigate([ROUTES.login]);
      return;
    }

    // isAuthenticated() is only set after restoreSession() runs — landing is
    // often the first page loaded, before any guard/login.page has had a
    // chance to check stored tokens. A returning user with a still-valid
    // session should skip the marketing page entirely.
    if (await this.auth.restoreSession()) {
      await this.router.navigate([ROUTES.messages]);
    }
  }

  goToLogin(): void { void this.router.navigate([ROUTES.login]); }
}
