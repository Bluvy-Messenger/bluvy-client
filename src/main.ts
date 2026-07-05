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

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideIonicAngular(),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideHttpClient(),
    { provide: MlsCoordinatorBase, useExisting: MlsCoordinatorService },
    // Detect OAuth callback (hash or query) before routing so the code is not
    // lost when Angular navigation clears window.location.hash.
    {
      provide: APP_INITIALIZER,
      useFactory: (oauthSvc: OAuthService) => () => oauthSvc.tryHandleInit(),
      deps: [OAuthService],
      multi: true,
    },
    provideServiceWorker('ngsw-worker.js', {
            enabled: !isDevMode(),
            registrationStrategy: 'registerWhenStable:30000'
          }),
  ],
});
