import { Injectable } from '@angular/core';
import { TRANSLATIONS } from './translations';

export type Locale = 'fr' | 'en';

@Injectable({ providedIn: 'root' })
export class TranslationService {
  locale: Locale;

  constructor() {
    const saved = localStorage.getItem('bluvy_locale') as Locale | null;
    if (saved === 'fr' || saved === 'en') {
      this.locale = saved;
    } else {
      this.locale = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
    }
  }

  currentLocale(): Locale {
    return this.locale;
  }

  setLocale(locale: Locale, reload = true): void {
    if (this.locale === locale) return;
    this.locale = locale;
    localStorage.setItem('bluvy_locale', locale);
    if (reload) {
      window.location.reload();
    }
  }

  t(key: string, params?: Record<string, string | number>): string {
    const dict = TRANSLATIONS[this.locale];
    let value = dict[key] ?? TRANSLATIONS['fr'][key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{${k}}`, String(v));
      }
    }
    return value;
  }
}
