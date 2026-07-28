import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { environment } from '../environments/environment';
import { IonApp, IonRouterOutlet, IonToast, IonIcon } from '@ionic/angular/standalone';
import { ConnectivityService } from './core/infrastructure/connectivity.service';
import { TranslatePipe } from './core/i18n/translate.pipe';
import { App } from '@capacitor/app';
import { addIcons } from 'ionicons';
import {
  chatbubble, chatbubbleOutline, people, peopleOutline, menu, menuOutline, searchOutline,
  personOutline, personAddOutline, chevronForwardOutline, phonePortraitOutline,
  shieldCheckmarkOutline, settingsOutline, informationCircleOutline,
  logOutOutline, chevronBackOutline, moonOutline, moon, sunnyOutline,
  sunny, contrastOutline, contrast, checkmarkCircleOutline, checkmarkCircle,
  eyeOutline, eyeOffOutline, lockClosedOutline, checkmarkDone,
  checkmarkDoneOutline, checkmarkOutline, send,
  // landing + legal + about
  arrowForwardOutline, fingerPrintOutline, keyOutline,
  documentTextOutline, businessOutline, shieldOutline, codeSlashOutline,
  chatbubbleEllipsesOutline, openOutline, reorderThreeOutline, copyOutline,
  // devices + security + settings
  laptopOutline, trashOutline, syncOutline,
  // language + beta + appearance
  globe, globeOutline, flaskOutline,
  colorPaletteOutline, colorFilterOutline, radioButtonOffOutline,
  ellipsisVerticalOutline, volumeMuteOutline, volumeHighOutline, banOutline,
  archiveOutline, folderOpenOutline, notificationsOutline, close,
} from 'ionicons/icons';
import { AuthService } from './core/auth/auth.service';
import { SocketService } from './core/infrastructure/socket.service';
import { DeviceProvisioningService } from './core/device/device-provisioning.service';
import { KeyPackageService } from './core/mls/key-package/key-package.service';
import { MlsCoordinatorBase } from './core/mls/coordinator/mls-coordinator.base';
import { ThemeService } from './core/theme/theme.service';
import { NavigationRedirectService } from './core/auth/navigation-redirect.service';
import { JournalService } from './core/journal/journal.service';
import { NotificationService } from './core/notification/notification.service';
import { PushNotificationService } from './core/notification/push-notification.service';
import { AccountBadgeService } from './core/notification/account-badge.service';
import { MessageCacheService } from './core/conversation/message-cache.service';
import { EmbedPreferencesService } from './core/embed/embed-preferences.service';
import { ROUTES } from './core/routes';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrl: 'app.component.scss',
  imports: [IonApp, IonRouterOutlet, IonToast, IonIcon, TranslatePipe],
})
export class AppComponent implements OnInit, OnDestroy {
  private authSvc      = inject(AuthService);
  private socketSvc    = inject(SocketService);
  private provisionSvc = inject(DeviceProvisioningService);
  private kpSvc        = inject(KeyPackageService);
  private coordinator  = inject(MlsCoordinatorBase);
  protected readonly notificationSvc = inject(NotificationService);
  private pushNotificationSvc = inject(PushNotificationService);
  private badgeSvc = inject(AccountBadgeService);
  private msgCacheSvc = inject(MessageCacheService);
  private embedPrefsSvc = inject(EmbedPreferencesService);
  private router = inject(Router);
  readonly connectivitySvc = inject(ConnectivityService);

  constructor() {
    inject(ThemeService);
    inject(NavigationRedirectService);
    inject(JournalService); // Start console interception at boot
    addIcons({
      chatbubble, chatbubbleOutline, people, peopleOutline, menu, menuOutline, searchOutline,
      personOutline, personAddOutline, chevronForwardOutline, phonePortraitOutline,
      shieldCheckmarkOutline, settingsOutline, informationCircleOutline,
      logOutOutline, chevronBackOutline, moonOutline, moon, sunnyOutline,
      sunny, contrastOutline, contrast, checkmarkCircleOutline, checkmarkCircle,
      eyeOutline, eyeOffOutline, lockClosedOutline, checkmarkDone,
      checkmarkDoneOutline, checkmarkOutline, send,
      arrowForwardOutline, fingerPrintOutline, keyOutline,
      documentTextOutline, businessOutline, shieldOutline, codeSlashOutline,
      laptopOutline, trashOutline, syncOutline,
      globe, globeOutline, flaskOutline,
      colorPaletteOutline, colorFilterOutline, radioButtonOffOutline,
      chatbubbleEllipsesOutline, openOutline, reorderThreeOutline, copyOutline,
      ellipsisVerticalOutline, volumeMuteOutline, volumeHighOutline, banOutline,
      archiveOutline, folderOpenOutline, notificationsOutline, close,
    });
  }

  private subs = new Subscription();

  ngOnInit(): void {
    this.notificationSvc.initialize();
    this.pushNotificationSvc.initialize();
    this.badgeSvc.initListeners();

    this.subs.add(
      this.socketSvc.deviceNew$.subscribe(payload => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device || payload.deviceId === device.id) return;
        void this.provisionSvc.handleDeviceNew(payload.deviceId, user, device, payload.reason ?? 'new');
      }),
    );

    this.subs.add(
      this.socketSvc.mlsCommit$.subscribe(payload => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        void this.coordinator.processIncomingCommit(
          payload.conversationId, payload.commit, payload.epoch, user, device,
        ).catch(err => { if (!environment.production) console.error('[AppComponent] mls:commit failed for conv', payload.conversationId, ':', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.reconnect$.subscribe(() => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        void this.provisionSvc.checkAndProvisionOnConnect(user, device);
        void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
          .catch(err => { if (!environment.production) console.error('[AppComponent] reconnect: ensureKeyPackagePool failed', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.mlsRefillKeyPackages$.subscribe(() => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        if (!environment.production) console.warn('[AppComponent] mls:refill_key_packages received — ensuring key package pool');
        void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
          .catch(err => { if (!environment.production) console.error('[AppComponent] refill: ensureKeyPackagePool failed', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.deviceRevoked$.subscribe(payload => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        if (!environment.production) console.warn('[AppComponent] device:revoked received for device:', payload.deviceId);
        void this.coordinator.removeRevokedDeviceFromAllGroups(payload.deviceId, user, device)
          .catch(err => { if (!environment.production) console.error('[AppComponent] deviceRevoked: remove failed', err); });
      }),
    );

    // Root Cause #3 fallback (Phase 9/10, see AUDIT_02/04/05): a conversation
    // was recreated (by this device or another member's). Splice the old
    // conversation's cached history into the new one locally so history stays
    // continuous, and redirect away if this device is currently viewing the
    // old conversation. Never touches MLS state directly -- the new
    // conversation's group is established the normal way (ensureGroupReady)
    // the next time it's opened, exactly like any brand-new conversation.
    this.subs.add(
      this.socketSvc.conversationSuperseded$.subscribe(async payload => {
        if (!environment.production) console.log('[AppComponent] conversation:superseded', payload);
        try {
          await this.msgCacheSvc.spliceHistory(payload.oldConversationId, payload.newConversationId);
        } catch (err) {
          if (!environment.production) console.error('[AppComponent] conversation:superseded splice failed', err);
        }

        const currentUrl = this.router.url;
        if (currentUrl.startsWith(ROUTES.conversation(payload.oldConversationId))) {
          void this.router.navigateByUrl(ROUTES.conversation(payload.newConversationId), { replaceUrl: true });
        }
      }),
    );

    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (!user || !device) return;
      void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
        .catch(err => { if (!environment.production) console.error('[AppComponent] foreground: ensureKeyPackagePool failed', err); });
      void this.embedPrefsSvc.refreshFromPds()
        .catch(err => { if (!environment.production) console.error('[AppComponent] foreground: embed preferences refresh failed', err); });
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }
}
