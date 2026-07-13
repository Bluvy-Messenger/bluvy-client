import { Injectable, effect, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { EdgeToEdge } from '@capawesome/capacitor-android-edge-to-edge-support';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ThemePalette = 'bluesky' | 'mu';
export type DarkThemeStyle = 'dim' | 'black';
export type AccentColor = 'blue' | 'pink' | 'orange';
export type FontFamily = 'system' | 'theme';
export type FontSize = 'small' | 'default' | 'large';

const SURFACE_LIGHT_BSKY = '#FFFFFF';
const SURFACE_DARK_BSKY  = '#151D28';
const SURFACE_DARK_BLACK = '#000000';
const SURFACE_LIGHT_MU   = '#F7F7F2';
const SURFACE_DARK_MU    = '#1F1F1F';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly KEY = 'theme';
  private static readonly PALETTE_KEY = 'palette';
  private static readonly DARK_STYLE_KEY = 'dark_theme_style';
  private static readonly ACCENT_KEY = 'accent_color';
  private static readonly FONT_FAMILY_KEY = 'font_family';
  private static readonly FONT_SIZE_KEY = 'font_size';

  readonly preference = signal<ThemeMode>(
    (localStorage.getItem(ThemeService.KEY) as ThemeMode) ?? 'auto',
  );

  readonly palette = signal<ThemePalette>(
    (localStorage.getItem(ThemeService.PALETTE_KEY) as ThemePalette) ?? 'bluesky',
  );

  readonly darkThemeStyle = signal<DarkThemeStyle>(
    (localStorage.getItem(ThemeService.DARK_STYLE_KEY) as DarkThemeStyle) ?? 'dim',
  );

  readonly accentColor = signal<AccentColor>(
    (localStorage.getItem(ThemeService.ACCENT_KEY) as AccentColor) ?? 'blue',
  );

  readonly fontFamily = signal<FontFamily>(
    (localStorage.getItem(ThemeService.FONT_FAMILY_KEY) as FontFamily) ?? 'theme',
  );

  readonly fontSize = signal<FontSize>(
    (localStorage.getItem(ThemeService.FONT_SIZE_KEY) as FontSize) ?? 'default',
  );

  constructor() {
    effect(() => this.apply(
      this.preference(),
      this.palette(),
      this.darkThemeStyle(),
      this.accentColor(),
      this.fontFamily(),
      this.fontSize()
    ));

    // Listen to OS prefers-color-scheme change for 'auto' mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.preference() === 'auto') {
        this.apply(
          this.preference(),
          this.palette(),
          this.darkThemeStyle(),
          this.accentColor(),
          this.fontFamily(),
          this.fontSize()
        );
      }
    });
  }

  set(mode: ThemeMode): void {
    localStorage.setItem(ThemeService.KEY, mode);
    this.preference.set(mode);
  }

  setPalette(palette: ThemePalette): void {
    localStorage.setItem(ThemeService.PALETTE_KEY, palette);
    this.palette.set(palette);
  }

  setDarkThemeStyle(style: DarkThemeStyle): void {
    localStorage.setItem(ThemeService.DARK_STYLE_KEY, style);
    this.darkThemeStyle.set(style);
  }

  setAccentColor(accent: AccentColor): void {
    localStorage.setItem(ThemeService.ACCENT_KEY, accent);
    this.accentColor.set(accent);
  }

  setFontFamily(font: FontFamily): void {
    localStorage.setItem(ThemeService.FONT_FAMILY_KEY, font);
    this.fontFamily.set(font);
  }

  setFontSize(size: FontSize): void {
    localStorage.setItem(ThemeService.FONT_SIZE_KEY, size);
    this.fontSize.set(size);
  }

  private apply(
    mode: ThemeMode,
    palette: ThemePalette,
    darkStyle: DarkThemeStyle,
    accent: AccentColor,
    font: FontFamily,
    size: FontSize
  ): void {
    const html = document.documentElement;

    // Apply color mode
    html.classList.remove('theme-dark', 'theme-light');
    if (mode === 'dark')  html.classList.add('theme-dark');
    if (mode === 'light') html.classList.add('theme-light');

    // Apply background palette (brand theme)
    html.classList.remove('palette-bluesky', 'palette-mu');
    html.classList.add(`palette-${palette}`);

    // Apply dark theme style class (theme-dark-black for OLED black)
    html.classList.remove('theme-dark-black');
    const isDark = mode === 'dark' ||
      (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark && darkStyle === 'black') {
      html.classList.add('theme-dark-black');
    }

    // Apply accent color class
    html.classList.remove('accent-blue', 'accent-pink', 'accent-orange');
    html.classList.add(`accent-${accent}`);

    // Apply font family class
    html.classList.remove('font-system');
    if (font === 'system') {
      html.classList.add('font-system');
    }

    // Apply font size class
    html.classList.remove('font-size-small', 'font-size-large');
    if (size === 'small') html.classList.add('font-size-small');
    if (size === 'large') html.classList.add('font-size-large');

    // Sync native status bar color
    let surfaceColor = SURFACE_LIGHT_BSKY;
    if (isDark) {
      if (darkStyle === 'black') {
        surfaceColor = SURFACE_DARK_BLACK;
      } else {
        surfaceColor = palette === 'mu' ? SURFACE_DARK_MU : SURFACE_DARK_BSKY;
      }
    } else {
      surfaceColor = palette === 'mu' ? SURFACE_LIGHT_MU : SURFACE_LIGHT_BSKY;
    }
    this.syncNativeStatusBar(surfaceColor);
  }

  private syncNativeStatusBar(color: string): void {
    if (Capacitor.getPlatform() !== 'android') return;
    void EdgeToEdge.setStatusBarColor({ color });
    void EdgeToEdge.setNavigationBarColor({ color });
  }
}
