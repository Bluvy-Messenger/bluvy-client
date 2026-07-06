import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { AvatarComponent } from '../../components/ui/avatar/avatar.component';
import { AuthService } from '../../core/auth/auth.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-menu',
  templateUrl: './menu.page.html',
  styleUrls: ['./menu.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, AvatarComponent, TranslatePipe],
})
export class MenuPage {
  auth           = inject(AuthService);
  private router = inject(Router);

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
