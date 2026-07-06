export const ROUTES = {
  welcome:            '/welcome',
  login:               '/login',
  oauthCallback:        '/oauth/callback',
  privacy:              '/privacy',
  terms:                '/terms',
  mentions:             '/mentions',
  licenses:             '/licenses',
  setupSync:            '/setup-sync',
  pinUnlock:            '/pin-unlock',
  recoveryUnlock:       '/recovery-unlock',
  migrateSync:          '/migrate-sync',

  conversations:      '/conversations',
  conversation:       (id: string) => `/conversations/${id}`,
  message:            (id: string) => `/conversations/${id}`, // alias for backward compatibility
  contacts:           '/contacts',
  contact:            (did: string) => `/contacts/${did}`,
  more:               '/menu', // alias for backward compatibility
  menu:               '/menu',
  profile:            '/profile',
  settings:           '/settings',
  settingsAppearance: '/settings/appearance',
  settingsLanguage:   '/settings/language',
  settingsSync:       '/settings/sync',
  security:           '/security',
  devices:            '/devices',
  about:              '/about',
} as const;
