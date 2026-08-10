import { Injectable, Injector, inject } from '@angular/core';
import { AtprotoRepoService, type AppSettingsRecord } from '../auth/atproto-repo.service';
import { ThemeService, type ThemeMode, type ThemePalette, type DarkThemeStyle, type AccentColor, type FontFamily, type FontSize } from '../theme/theme.service';
import { TranslationService, type Locale } from '../i18n/translation.service';
import { NotificationService } from '../notification/notification.service';
import { PushNotificationService } from '../notification/push-notification.service';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AppPreferencesSyncService {
  private injector       = inject(Injector);
  private atprotoRepo    = inject(AtprotoRepoService);
  private themeSvc       = inject(ThemeService);
  private translationSvc = inject(TranslationService);

  private get notifSvc(): NotificationService { return this.injector.get(NotificationService); }
  private get pushNotifSvc(): PushNotificationService { return this.injector.get(PushNotificationService); }

  private isSyncing = false;
  private saveTimeout: any = null;

  /**
   * Bootstraps user app preferences from PDS upon authentication / session restore.
   * If PDS record exists: applies settings locally.
   * If PDS record is empty: uploads initial local preferences to PDS.
   */
  async bootstrap(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const pdsRecord = await this.atprotoRepo.getAppSettingsPreferences();

      if (pdsRecord) {
        if (!environment.production) console.log('[AppPreferencesSyncService] Loaded PDS app settings:', pdsRecord);

        // Apply Theme
        if (pdsRecord.theme) {
          if (pdsRecord.theme.mode)       this.themeSvc.setMode(pdsRecord.theme.mode as ThemeMode);
          if (pdsRecord.theme.palette)    this.themeSvc.setPalette(pdsRecord.theme.palette as ThemePalette);
          if (pdsRecord.theme.darkStyle)  this.themeSvc.setDarkStyle(pdsRecord.theme.darkStyle as DarkThemeStyle);
          if (pdsRecord.theme.accent)     this.themeSvc.setAccent(pdsRecord.theme.accent as AccentColor);
          if (pdsRecord.theme.fontFamily) this.themeSvc.setFontFamily(pdsRecord.theme.fontFamily as FontFamily);
          if (pdsRecord.theme.fontSize)   this.themeSvc.setFontSize(pdsRecord.theme.fontSize as FontSize);
        }

        // Apply Locale / Language
        if (pdsRecord.locale && pdsRecord.locale !== this.translationSvc.currentLocale()) {
          this.translationSvc.setLocale(pdsRecord.locale as Locale, false);
        }

        // Apply Notifications
        if (pdsRecord.notifications) {
          if (typeof pdsRecord.notifications.inAppEnabled === 'boolean') {
            this.notifSvc.setInAppNotificationsEnabled(pdsRecord.notifications.inAppEnabled);
          }
          if (typeof pdsRecord.notifications.pushEnabled === 'boolean') {
            this.pushNotifSvc.setPushNotificationsEnabled(pdsRecord.notifications.pushEnabled);
          }
        }

        // Apply Muted Conversations
        if (Array.isArray(pdsRecord.mutedConversationIds)) {
          for (const convId of pdsRecord.mutedConversationIds) {
            localStorage.setItem('muted_conv_' + convId, 'true');
          }
        }

        // Apply Blocked Contacts
        if (Array.isArray(pdsRecord.blockedContactDids)) {
          for (const did of pdsRecord.blockedContactDids) {
            localStorage.setItem('blocked_contact_' + did, 'true');
          }
        }
      } else {
        // Initial sync: Upload current local settings to PDS
        if (!environment.production) console.log('[AppPreferencesSyncService] No PDS record found, initializing PDS settings from local state.');
        await this.syncToPdsNow();
      }
    } catch (err) {
      if (!environment.production) console.warn('[AppPreferencesSyncService] Bootstrap sync failed:', err);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Schedule a debounced update to PDS whenever any app setting is changed.
   */
  scheduleSave(): void {
    if (this.isSyncing) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);

    this.saveTimeout = setTimeout(() => {
      void this.syncToPdsNow();
    }, 1000);
  }

  /**
   * Immediately saves current local preferences to PDS.
   */
  async syncToPdsNow(): Promise<void> {
    // Collect all muted conversation IDs from localStorage
    const mutedConversationIds: string[] = [];
    const blockedContactDids: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('muted_conv_') && localStorage.getItem(key) === 'true') {
        mutedConversationIds.push(key.replace('muted_conv_', ''));
      } else if (key?.startsWith('blocked_contact_') && localStorage.getItem(key) === 'true') {
        blockedContactDids.push(key.replace('blocked_contact_', ''));
      }
    }

    const record: AppSettingsRecord = {
      theme: {
        mode:       this.themeSvc.mode(),
        palette:    this.themeSvc.palette(),
        darkStyle:  this.themeSvc.darkStyle(),
        accent:     this.themeSvc.accent(),
        fontFamily: this.themeSvc.fontFamily(),
        fontSize:   this.themeSvc.fontSize(),
      },
      locale: this.translationSvc.currentLocale(),
      notifications: {
        inAppEnabled: this.notifSvc.isInAppNotificationsEnabled(),
        pushEnabled:  this.pushNotifSvc.isPushNotificationsEnabled(),
      },
      mutedConversationIds,
      blockedContactDids,
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.atprotoRepo.putAppSettingsPreferences(record);
      if (!environment.production) console.log('[AppPreferencesSyncService] Preferences synced to PDS successfully.');
    } catch (err) {
      if (!environment.production) console.warn('[AppPreferencesSyncService] Failed to sync preferences to PDS:', err);
    }
  }
}
