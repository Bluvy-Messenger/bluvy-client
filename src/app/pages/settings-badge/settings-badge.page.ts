import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';
import { AuthService } from '../../core/auth/auth.service';
import { BadgeVisibilityService } from '../../core/badge/badge-visibility.service';
import { BADGE_VISIBILITY_OPTIONS, type BadgeVisibility } from '../../core/badge/badge-visibility.types';

@Component({
  selector: 'app-settings-badge',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-badge.page.html',
  styleUrls: ['./settings-badge.page.scss'],
})
export class SettingsBadgePage implements OnInit {
  private router   = inject(Router);
  private authSvc  = inject(AuthService);
  protected badgeSvc = inject(BadgeVisibilityService);

  readonly options = BADGE_VISIBILITY_OPTIONS;

  async ngOnInit(): Promise<void> {
    const did = this.authSvc.currentUser()?.did;
    if (!did) return;
    await this.badgeSvc.bootstrap(did);
    void this.badgeSvc.refreshFromPds(did);
  }

  goBack(): void {
    void this.router.navigate([ROUTES.settingsPrivacy]);
  }

  select(value: BadgeVisibility): void {
    const did = this.authSvc.currentUser()?.did;
    if (!did) return;
    void this.badgeSvc.setShowButtonTo(value, did, this.authSvc.currentDevice()?.id);
  }
}
