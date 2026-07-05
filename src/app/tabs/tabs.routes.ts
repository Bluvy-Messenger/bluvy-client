import { Routes } from '@angular/router';
import { TabsPage } from './tabs.page';

export const routes: Routes = [
  {
    path: '',
    component: TabsPage,
    children: [
      {
        path: 'conversations',
        loadComponent: () =>
          import('../pages/conversations/conversations.page').then(m => m.ConversationsPage),
      },
      {
        path: 'contacts',
        loadComponent: () =>
          import('../pages/contacts/contacts.page').then(m => m.ContactsPage),
      },
      {
        path: 'conversations/:id',
        loadComponent: () =>
          import('../pages/conversation/conversation.page').then(m => m.ConversationPage),
      },
      {
        path: 'menu',
        loadComponent: () =>
          import('../pages/menu/menu.page').then(m => m.MenuPage),
      },
      {
        path: 'sync-settings',
        loadComponent: () =>
          import('../pages/sync-settings/sync-settings.page').then(m => m.SyncSettingsPage),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('../pages/settings/settings.page').then(m => m.SettingsPage),
      },
      {
        path: 'settings/appearance',
        loadComponent: () =>
          import('../pages/settings-appearance/settings-appearance.page')
            .then(m => m.SettingsAppearancePage),
      },
      {
        path: 'settings/language',
        loadComponent: () =>
          import('../pages/settings-language/settings-language.page')
            .then(m => m.SettingsLanguagePage),
      },
      {
        path: 'security',
        loadComponent: () =>
          import('../pages/security/security.page').then(m => m.SecurityPage),
      },
      {
        path: 'devices',
        loadComponent: () =>
          import('../pages/devices/devices.page').then(m => m.DevicesPage),
      },
      {
        path: 'about',
        loadComponent: () =>
          import('../pages/about/about.page').then(m => m.AboutPage),
      },
      {
        path: '',
        redirectTo: 'conversations',
        pathMatch: 'full',
      },
    ],
  },
];
