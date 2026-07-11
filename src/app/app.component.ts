import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { environment } from '../environments/environment';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { App } from '@capacitor/app';
import { addIcons } from 'ionicons';
import {
  chatbubble, chatbubbleOutline, people, peopleOutline, menu, menuOutline, searchOutline,
  personOutline, chevronForwardOutline, phonePortraitOutline,
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
} from 'ionicons/icons';
import { AuthService } from './core/auth/auth.service';
import { SocketService } from './core/infrastructure/socket.service';
import { DeviceProvisioningService } from './core/device/device-provisioning.service';
import { KeyPackageService } from './core/mls/key-package/key-package.service';
import { MlsCoordinatorBase } from './core/mls/coordinator/mls-coordinator.base';
import { ThemeService } from './core/theme/theme.service';
import { NavigationRedirectService } from './core/auth/navigation-redirect.service';
import { JournalService } from './core/journal/journal.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent implements OnInit, OnDestroy {
  private authSvc      = inject(AuthService);
  private socketSvc    = inject(SocketService);
  private provisionSvc = inject(DeviceProvisioningService);
  private kpSvc        = inject(KeyPackageService);
  private coordinator  = inject(MlsCoordinatorBase);

  constructor() {
    inject(ThemeService);
    inject(NavigationRedirectService);
    inject(JournalService); // Start console interception at boot
    addIcons({
      chatbubble, chatbubbleOutline, people, peopleOutline, menu, menuOutline, searchOutline,
      personOutline, chevronForwardOutline, phonePortraitOutline,
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
    });
  }

  private subs = new Subscription();

  ngOnInit(): void {
    this.subs.add(
      this.socketSvc.deviceNew$.subscribe(payload => {
        const user   = this.authSvc.currentUser();
        const device = this.authSvc.currentDevice();
        if (!user || !device || payload.deviceId === device.id) return;
        void this.provisionSvc.handleDeviceNew(payload.deviceId, user, device);
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

    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      const user   = this.authSvc.currentUser();
      const device = this.authSvc.currentDevice();
      if (!user || !device) return;
      void this.kpSvc.ensureKeyPackagePool(user.did, device.id)
        .catch(err => { if (!environment.production) console.error('[AppComponent] foreground: ensureKeyPackagePool failed', err); });
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }
}
