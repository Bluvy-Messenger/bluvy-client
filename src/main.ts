import './app/core/infrastructure/webcrypto-polyfill';

if (typeof window !== 'undefined' && window.location.hash) {
  const hash = window.location.hash;
  const match = hash.match(/^#(did:[a-z0-9\.\-:]+)(?:\+(did:[a-z0-9\.\-:]+))?$/i);
  if (match) {
    const targetDid = match[1]!;
    const viewerDid = match[2] || null;
    sessionStorage.setItem('bluvy_invite_context', JSON.stringify({ targetDid, viewerDid }));
    // Clear hash immediately so the router doesn't get confused
    window.location.hash = '';
    window.history.replaceState(null, '', window.location.pathname);
  }
}

import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withPreloading, PreloadAllModules } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular, ToastController } from '@ionic/angular/standalone';
import { provideHttpClient } from '@angular/common/http';
import { Injectable, ErrorHandler, inject, isDevMode, APP_INITIALIZER } from '@angular/core';
import { environment } from './environments/environment';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { MlsCoordinatorBase } from './app/core/mls/coordinator/mls-coordinator.base';
import { MlsCoordinatorService } from './app/core/mls/coordinator/mls-coordinator.service';
import { provideServiceWorker } from '@angular/service-worker';
import { OAuthService } from './app/core/auth/oauth.service';
import { Capacitor } from '@capacitor/core';

@Injectable()
class GlobalErrorHandler implements ErrorHandler {
  private readonly toastCtrl = inject(ToastController);

  handleError(error: unknown): void {
    if (!environment.production) console.error('[GlobalError]', error);
    void this.toastCtrl.create({
      message:  'An unexpected error occurred.',
      duration: 3000,
      color:    'danger',
      position: 'bottom',
    }).then(t => t.present()).catch(() => {});
  }
}

async function checkAndClearCache(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const currentVersion = environment.version;
  const cachedVersion  = localStorage.getItem('bluvy_app_version');

  if (cachedVersion && cachedVersion !== currentVersion) {
    console.log(`[Version Update] App version changed from ${cachedVersion} to ${currentVersion}. Clearing cache storage and service workers...`);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
      sessionStorage.clear();

      localStorage.setItem('bluvy_app_version', currentVersion);
      window.location.reload();
      return true; // Reloading, skip bootstrap
    } catch (err) {
      console.error('[Version Update] Error clearing cache:', err);
    }
  }

  if (!cachedVersion) {
    localStorage.setItem('bluvy_app_version', currentVersion);
  }
  return false;
}

void checkAndClearCache().then((reloading) => {
  if (reloading) return;

  bootstrapApplication(AppComponent, {
    providers: [
      { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
      { provide: ErrorHandler, useClass: GlobalErrorHandler },
      provideIonicAngular(),
      provideRouter(routes, withPreloading(PreloadAllModules)),
      provideHttpClient(),
      { provide: MlsCoordinatorBase, useExisting: MlsCoordinatorService },
      {
        provide: APP_INITIALIZER,
        useFactory: (oauthSvc: OAuthService) => () => oauthSvc.tryHandleInit(),
        deps: [OAuthService],
        multi: true,
      },
      provideServiceWorker('ngsw-worker.js', {
        enabled: !isDevMode() && !Capacitor.isNativePlatform(),
        registrationStrategy: 'registerWhenStable:30000'
      }),
    ],
  });
});
