import { Component, OnInit, OnDestroy, ViewChild, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { environment } from '../environments/environment';
import { IonApp, IonRouterOutlet, IonIcon, Platform, ToastController, AlertController } from '@ionic/angular/standalone';
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
  arrowForwardOutline, fingerPrintOutline, keyOutline, linkOutline,
  documentTextOutline, businessOutline, shieldOutline, codeSlashOutline,
  chatbubbleEllipsesOutline, openOutline, reorderThreeOutline, copyOutline,
  // devices + security + settings
  laptopOutline, trashOutline, syncOutline, swapHorizontalOutline,
  // language + beta + appearance
  globe, globeOutline, flaskOutline,
  colorPaletteOutline, colorFilterOutline, radioButtonOffOutline,
  ellipsisVerticalOutline, volumeMuteOutline, volumeHighOutline, banOutline,
  archiveOutline, folderOpenOutline, notificationsOutline, close,
  // embed provider fallback cards
  logoYoutube, logoTiktok, logoTwitch, musicalNotesOutline, filmOutline, imageOutline,
  // native Bluesky post card
  heart, heartOutline, playCircle, repeat, repeatOutline, cloudOfflineOutline,
  createOutline, closeOutline, closeCircle, alertCircleOutline,
  // notes & system
  bookmark, bookmarkOutline, pin, pinOutline, cloudDoneOutline, timeOutline, lockClosed, arrowUpOutline,
} from 'ionicons/icons';
import { AuthService } from './core/auth/auth.service';
import { OAuthService } from './core/auth/oauth.service';
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
import { TranslationService } from './core/i18n/translation.service';
import { SyncService } from './core/sync/sync.service';
import { ROUTES } from './core/routes';
import type { WelcomeNewPayload } from './core/infrastructure/socket.types';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrl: 'app.component.scss',
  imports: [IonApp, IonRouterOutlet, IonIcon, TranslatePipe],
})
export class AppComponent implements OnInit, OnDestroy {
  private authSvc      = inject(AuthService);
  private oauthSvc     = inject(OAuthService);
  private alertCtrl    = inject(AlertController);
  private socketSvc    = inject(SocketService);
  private provisionSvc = inject(DeviceProvisioningService);
  private kpSvc        = inject(KeyPackageService);
  private coordinator  = inject(MlsCoordinatorBase);
  protected readonly notificationSvc = inject(NotificationService);
  private pushNotificationSvc = inject(PushNotificationService);
  private badgeSvc = inject(AccountBadgeService);
  private msgCacheSvc = inject(MessageCacheService);
  private embedPrefsSvc = inject(EmbedPreferencesService);
  private syncSvc = inject(SyncService);
  private router = inject(Router);
  private platform = inject(Platform);
  private toastCtrl = inject(ToastController);
  private i18n = inject(TranslationService);
  readonly connectivitySvc = inject(ConnectivityService);

  @ViewChild(IonRouterOutlet) private routerOutlet?: IonRouterOutlet;

  constructor() {
    inject(ThemeService);
    inject(NavigationRedirectService);
    inject(JournalService); // Console capture already started in main.ts; this wires up IndexedDB persistence
    addIcons({
      chatbubble, chatbubbleOutline, people, peopleOutline, menu, menuOutline, searchOutline,
      personOutline, personAddOutline, chevronForwardOutline, phonePortraitOutline,
      shieldCheckmarkOutline, settingsOutline, informationCircleOutline,
      logOutOutline, chevronBackOutline, moonOutline, moon, sunnyOutline,
      sunny, contrastOutline, contrast, checkmarkCircleOutline, checkmarkCircle,
      eyeOutline, eyeOffOutline, lockClosedOutline, checkmarkDone,
      checkmarkDoneOutline, checkmarkOutline, send,
      arrowForwardOutline, fingerPrintOutline, keyOutline, linkOutline,
      documentTextOutline, businessOutline, shieldOutline, codeSlashOutline,
      laptopOutline, trashOutline, syncOutline, swapHorizontalOutline,
      globe, globeOutline, flaskOutline,
      colorPaletteOutline, colorFilterOutline, radioButtonOffOutline,
      chatbubbleEllipsesOutline, openOutline, reorderThreeOutline, copyOutline,
      ellipsisVerticalOutline, volumeMuteOutline, volumeHighOutline, banOutline,
      archiveOutline, folderOpenOutline, notificationsOutline, close,
      logoYoutube, logoTiktok, logoTwitch, musicalNotesOutline, filmOutline, imageOutline,
      heart, heartOutline, playCircle, repeat, repeatOutline, cloudOfflineOutline,
      createOutline, closeOutline, closeCircle, alertCircleOutline,
      bookmark, bookmarkOutline, pin, pinOutline, cloudDoneOutline, timeOutline, lockClosed, arrowUpOutline,
    });

    // OAuthService.sessionUnavailable flips true when a PDS-touching feature
    // (declaration sync, embed prefs, badge visibility) found the backend
    // session valid but couldn't restore an ATProto OAuth session for it --
    // two independent credentials that can desync. Only a fresh interactive
    // OAuth authorization (PKCE redirect) can fix that, so prompt once per
    // app session rather than failing silently at each call site.
    effect(() => {
      const unavailable = this.oauthSvc.sessionUnavailable();
      if (unavailable && this.authSvc.isAuthenticated() && !this.reconnectPrompted) {
        this.reconnectPrompted = true;
        void this.promptReconnectAtproto();
      }
    });
  }

  private reconnectPrompted = false;
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
        ).catch(err => { console.error('[AppComponent] mls:commit failed for conv', payload.conversationId, ':', err); });
      }),
    );

    // Global welcomeNew$ subscriber (forensic audit finding F6): before this,
    // the only subscribers were conversation.page.ts (only while that
    // conversation is open) and the dead conversation-panel.component.ts. A
    // Welcome for a conversation not currently open was only picked up by the
    // next REST poll (getPendingWelcomes), which itself requires already
    // knowing the conversationId -- there is no "list all my pending
    // welcomes" endpoint. processWelcome() is idempotent on an already-READY
    // conversation (mls-coordinator.service.ts) and the Welcome digest guard
    // (mls.service.ts) makes a double-fire with conversation.page.ts's own
    // subscriber safe when the conversation happens to be open too.
    this.subs.add(
      this.socketSvc.welcomeNew$.subscribe((payload: WelcomeNewPayload) => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device || !payload.conversationId) return;
        void this.coordinator.processWelcome(payload.id, payload.welcome, payload.conversationId, user, device)
          .catch(err => { console.error('[AppComponent] welcomeNew$ processWelcome failed for conv', payload.conversationId, ':', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.reconnect$.subscribe(() => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        void this.provisionSvc.checkAndProvisionOnConnect(user, device);
        void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
          .catch(err => { console.error('[AppComponent] reconnect: ensureKeyPackagePool failed', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.mlsRefillKeyPackages$.subscribe(() => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        if (!environment.production) console.warn('[AppComponent] mls:refill_key_packages received — ensuring key package pool');
        void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
          .catch(err => { console.error('[AppComponent] refill: ensureKeyPackagePool failed', err); });
      }),
    );

    this.subs.add(
      this.socketSvc.deviceRevoked$.subscribe(payload => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device) return;
        if (!environment.production) console.warn('[AppComponent] device:revoked received for device:', payload.deviceId);
        void this.coordinator.removeRevokedDeviceFromAllGroups(payload.deviceId, user, device)
          .catch(err => { console.error('[AppComponent] deviceRevoked: remove failed', err); });
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
          console.error('[AppComponent] conversation:superseded splice failed', err);
        }

        const currentUrl = this.router.url;
        if (currentUrl.startsWith(ROUTES.conversation(payload.oldConversationId))) {
          void this.router.navigateByUrl(ROUTES.conversation(payload.newConversationId), { replaceUrl: true });
        }
      }),
    );

    // Global, not scoped to conversation.page.ts -- recovery can also happen
    // in the background (recoverFromFailed) while the user isn't viewing the
    // affected conversation. Only surfaced when something couldn't be saved.
    this.subs.add(
      this.coordinator.historyRecoveryCompleted$.subscribe(async event => {
        if (!environment.production) console.log('[AppComponent] historyRecoveryCompleted', event);
        if (event.stillUndecryptable <= 0) return;
        try {
          const toast = await this.toastCtrl.create({
            message:  this.i18n.t('conversation.history_partially_recovered', { count: String(event.stillUndecryptable) }),
            duration: 4500,
            position: 'bottom',
            color:    'medium',
          });
          await toast.present();
        } catch {
          // Non-critical -- ignore.
        }
      }),
    );

    // Another of this account's devices rotated the MBK (see devices.page.ts
    // revoke flow) -- drop the now-stale local copy so this device can't
    // keep silently encrypting new data under a key that no longer matches
    // the backend. No forced navigation: the existing "MBK not unlocked yet"
    // path (onGroupNotReady) already prompts for the PIN the next time sync
    // genuinely needs it, same as any brand-new device.
    this.subs.add(
      this.socketSvc.mbkRotated$.subscribe(payload => {
        if (!environment.production) console.log('[AppComponent] mbk:rotated', payload);
        this.syncSvc.handleRemoteRotation(payload.keyGeneration);
      }),
    );

    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (!user || !device) return;
      void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
        .catch(err => { console.error('[AppComponent] foreground: ensureKeyPackagePool failed', err); });
      void this.embedPrefsSvc.refreshFromPds()
        .catch(err => { console.error('[AppComponent] foreground: embed preferences refresh failed', err); });
    });

    // This empty listener is required for Android hardware back to reach
    // Ionic at all: Capacitor's native side only forwards the event into
    // the 'backbutton' DOM event (which Platform.backButton below listens
    // to) when at least one 'backButton' listener is registered -- with
    // none registered, it silently replays the WebView's own history
    // instead. The actual handling lives in Platform.backButton so it
    // stays coordinated with Ionic's own default pop handler (priority 0)
    // instead of running a second, uncoordinated navigation in parallel.
    void App.addListener('backButton', () => {});

    // Priority 1 runs before Ionic's own default handler (priority 0,
    // which calls NavController.pop()). If the ion-router-outlet stack can
    // still pop, defer to that default. Otherwise the stack is exhausted
    // -- e.g. a cold start opened directly into a conversation from a
    // notification tap -- and letting the event fall through would exit
    // the app instead of landing somewhere sensible.
    this.platform.backButton.subscribeWithPriority(1, (processNextHandler) => {
      if (this.routerOutlet?.canGoBack()) {
        processNextHandler();
        return;
      }
      void this.router.navigate(
        [this.authSvc.isAuthenticated() ? ROUTES.conversations : ROUTES.welcome],
        { replaceUrl: true },
      );
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private async promptReconnectAtproto(): Promise<void> {
    const handle = this.authSvc.currentUser()?.handle;
    if (!handle) return;

    const alert = await this.alertCtrl.create({
      header:  this.i18n.t('atproto.reconnect.title'),
      message: this.i18n.t('atproto.reconnect.message'),
      buttons: [
        {
          text: this.i18n.t('atproto.reconnect.later'),
          role: 'cancel',
        },
        {
          text: this.i18n.t('atproto.reconnect.confirm'),
          handler: () => {
            // Allow re-prompting if this attempt doesn't actually resolve it
            // (e.g. the user cancels the OAuth redirect).
            this.reconnectPrompted = false;
            void this.oauthSvc.signIn(handle);
          },
        },
      ],
    });
    await alert.present();
  }
}
