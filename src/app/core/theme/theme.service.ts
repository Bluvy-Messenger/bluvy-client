import { Injectable, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';

export type ThemeMode = 'auto' | 'light' | 'dark';

const SURFACE_LIGHT = '#FFFFFF';
const SURFACE_DARK  = '#1E293B';

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

    const isDark = mode === 'dark' ||
      (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    this.syncNativeStatusBar(isDark ? SURFACE_DARK : SURFACE_LIGHT);
  }

  private syncNativeStatusBar(color: string): void {
    if (Capacitor.getPlatform() !== 'android') return;
    void EdgeToEdge.setStatusBarColor({ color });
    void EdgeToEdge.setNavigationBarColor({ color });
  }
}
