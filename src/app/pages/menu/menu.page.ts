import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { AuthService, StoredAccount } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { AccountBadgeService } from '../../core/notification/account-badge.service';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-menu',
  templateUrl: './menu.page.html',
  styleUrls: ['./menu.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, AvatarComponent, TranslatePipe],
})
export class MenuPage implements OnInit {
  auth           = inject(AuthService);
  badgeSvc       = inject(AccountBadgeService);
  private router = inject(Router);

  accounts: StoredAccount[] = [];
  switching = false;

  async ngOnInit(): Promise<void> {
    await this.loadAccounts();
  }

  async ionViewWillEnter(): Promise<void> {
    // Refresh unread badges for inactive accounts every time the menu is opened
    void this.badgeSvc.refresh();
  }

  async loadAccounts(): Promise<void> {
    this.accounts = await this.auth.getStoredAccounts();
  }

  async switchAccount(did: string): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      await this.auth.switchAccount(did);
    } finally {
      this.switching = false;
      await this.loadAccounts();
    }
  }

  async addAccount(): Promise<void> {
    await this.auth.prepareForAddAccount();
  }

  openProfile(): void {
    void this.router.navigate([ROUTES.profile]);
  }

  openSecurity(): void {
    void this.router.navigate([ROUTES.security]);
  }

  openSettings(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  openAbout(): void {
    void this.router.navigate([ROUTES.about]);
  }
}
