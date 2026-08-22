import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-settings-language',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-language.page.html',
  styleUrls: ['./settings-language.page.scss'],
})
export class SettingsLanguagePage {
  private router = inject(Router);
  protected translate = inject(TranslateService);

  goBack(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  setLocale(locale: 'fr' | 'en'): void {
    this.translate.use(locale);
  }
}
