import { Component, inject, computed, effect } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { filter, map, startWith } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonTabs, IonTabBar, IonTabButton, IonIcon } from '@ionic/angular/standalone';
import { ReceiptsService } from '../core/receipts/receipts.service';
import { UnreadBadgeComponent } from '../components/chat/unread-badge/unread-badge.component';
import { TranslatePipe } from '../core/i18n/translate.pipe';
import { AvatarComponent } from '../components/ui/avatar/avatar.component';
import { BreakpointService } from '../core/layout/breakpoint.service';
import { AuthService } from '../core/auth/auth.service';

@Component({
  selector: 'app-tabs',
  templateUrl: 'tabs.page.html',
  styleUrls: ['tabs.page.scss'],
  standalone: true,
  imports: [
    IonTabs, IonTabBar, IonTabButton, IonIcon,
    AsyncPipe,
    UnreadBadgeComponent,
    AvatarComponent,
    TranslatePipe,
  ],
})
export class TabsPage {
  readonly receiptsSvc = inject(ReceiptsService);
  readonly bpSvc       = inject(BreakpointService);
  readonly auth        = inject(AuthService);
  private readonly router = inject(Router);

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      map(e => (e as NavigationEnd).urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  readonly isConvRoute = computed(() =>
    /\/tabs\/conversations\/.+/.test(this.currentUrl() ?? ''));

  readonly showTabBar = computed(() =>
    !this.bpSvc.isTablet() && !this.isConvRoute());

  constructor() {
    // Redirect away from the mobile-only menu page on tablet/desktop
    effect(() => {
      const url = this.currentUrl();
      if (this.bpSvc.isTablet() && url?.startsWith('/tabs/menu')) {
        void this.router.navigate(['/tabs/conversations']);
      }
    });
  }

  isActive(prefix: string): boolean {
    const url = this.currentUrl() ?? '';
    return url === prefix || url.startsWith(prefix + '/');
  }

  isSecurityActive(): boolean {
    const url = this.currentUrl() ?? '';
    return url.startsWith('/tabs/security') || url.startsWith('/tabs/devices');
  }

  navigate(path: string): void { void this.router.navigate([path]); }
}
