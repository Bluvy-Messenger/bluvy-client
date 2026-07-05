import { Injectable, effect, signal } from '@angular/core';

export type ThemeMode = 'auto' | 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly KEY = 'theme';

  readonly preference = signal<ThemeMode>(
    (localStorage.getItem(ThemeService.KEY) as ThemeMode) ?? 'auto',
  );

  constructor() {
    effect(() => this.apply(this.preference()));
  }

  set(mode: ThemeMode): void {
    localStorage.setItem(ThemeService.KEY, mode);
    this.preference.set(mode);
  }

  private apply(mode: ThemeMode): void {
    const html = document.documentElement;
    html.classList.remove('theme-dark', 'theme-light');
    if (mode === 'dark')  html.classList.add('theme-dark');
    if (mode === 'light') html.classList.add('theme-light');
  }
}
