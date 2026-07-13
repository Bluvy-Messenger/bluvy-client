import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { ThemeService, type ThemeMode, type ThemePalette, type DarkThemeStyle, type AccentColor, type FontFamily, type FontSize } from '../../core/theme/theme.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { ROUTES } from '../../core/routes';

@Component({
  selector: 'app-settings-appearance',
  standalone: true,
  imports: [IonContent, IonIcon, TranslatePipe],
  templateUrl: './settings-appearance.page.html',
  styleUrls: ['./settings-appearance.page.scss'],
})
export class SettingsAppearancePage {
  private router   = inject(Router);
  private themeSvc = inject(ThemeService);

  readonly preference     = this.themeSvc.preference;
  readonly palette        = this.themeSvc.palette;
  readonly darkThemeStyle = this.themeSvc.darkThemeStyle;
  readonly accentColor    = this.themeSvc.accentColor;
  readonly fontFamily     = this.themeSvc.fontFamily;
  readonly fontSize       = this.themeSvc.fontSize;

  goBack(): void {
    void this.router.navigate([ROUTES.settings]);
  }

  setMode(mode: ThemeMode): void {
    this.themeSvc.set(mode);
  }

  setPalette(palette: ThemePalette): void {
    this.themeSvc.setPalette(palette);
  }

  setDarkThemeStyle(style: DarkThemeStyle): void {
    this.themeSvc.setDarkThemeStyle(style);
  }

  setAccentColor(accent: AccentColor): void {
    this.themeSvc.setAccentColor(accent);
  }

  setFontFamily(font: FontFamily): void {
    this.themeSvc.setFontFamily(font);
  }

  setFontSize(size: FontSize): void {
    this.themeSvc.setFontSize(size);
  }
}
