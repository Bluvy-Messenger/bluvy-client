import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { environment } from '../../../environments/environment';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './about.page.html',
  styleUrls: ['./about.page.scss'],
})
export class AboutPage {
  private router   = inject(Router);

  readonly version = environment.version;

  goBack(): void {
    void this.router.navigate([ROUTES.menu]);
  }

  navigate(path: string): void { void this.router.navigate([path]); }
}
