import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { TranslationService } from '../../core/i18n/translation.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';

@Component({
  selector: 'app-settings-language',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-language.page.html',
  styleUrls: ['./settings-language.page.scss'],
})
export class SettingsLanguagePage {
  @Input() embedded = false;
  @Output() navigateBack = new EventEmitter<void>();

  private router = inject(Router);
  protected i18n = inject(TranslationService);

  goBack(): void {
    if (this.embedded) { this.navigateBack.emit(); return; }
    void this.router.navigate(['/tabs/settings']);
  }

  setLocale(locale: 'fr' | 'en'): void {
    this.i18n.setLocale(locale);
  }
}
