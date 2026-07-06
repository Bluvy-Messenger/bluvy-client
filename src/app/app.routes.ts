import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { rootGuard } from './core/guards/root.guard';

export const routes: Routes = [
  {
    path: 'welcome',
    loadComponent: () => import('./pages/landing/landing.page').then(m => m.LandingPage),
  },
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login.page').then(m => m.LoginPage),
  },
  {
    path: 'oauth/callback',
    loadComponent: () => import('./pages/oauth-callback/oauth-callback.page').then(m => m.OauthCallbackPage),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/legal/privacy.page').then(m => m.PrivacyPage),
  },
  {
    path: 'terms',
    loadComponent: () => import('./pages/legal/terms.page').then(m => m.TermsPage),
  },
  {
    path: 'mentions',
    loadComponent: () => import('./pages/legal/mentions.page').then(m => m.MentionsPage),
  },
  {
    path: 'licenses',
    loadComponent: () => import('./pages/legal/licenses.page').then(m => m.LicensesPage),
  },
  {
    path: 'setup-sync',
    loadComponent: () => import('./pages/setup-sync/setup-sync.page').then(m => m.SetupSyncPage),
    canActivate: [authGuard],
  },
  {
    path: 'pin-unlock',
    loadComponent: () => import('./pages/pin-unlock/pin-unlock.page').then(m => m.PinUnlockPage),
    canActivate: [authGuard],
  },
  {
    path: 'recovery-unlock',
    loadComponent: () => import('./pages/recovery-unlock/recovery-unlock.page').then(m => m.RecoveryUnlockPage),
    canActivate: [authGuard],
  },
  {
    path: 'migrate-sync',
    loadComponent: () => import('./pages/migrate-sync/migrate-sync.page').then(m => m.MigrateSyncPage),
    canActivate: [authGuard],
  },
  {
    path: '',
    loadChildren: () => import('./tabs/tabs.routes').then(m => m.routes),
    canActivate: [rootGuard],
  },
];
