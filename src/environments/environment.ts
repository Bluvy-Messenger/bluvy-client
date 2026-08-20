export const environment = {
  production:    false,
  version:       '1.0.15.4',
  apiUrl:        'http://localhost:3000',
  socketUrl:     'http://localhost:3000',
  oauthClientId: 'http://localhost',
  // aud for com.atproto.server.getServiceAuth — must match backend's ATPROTO_SERVICE_DID.
  oauthServiceDid: 'did:web:bluvy.app',
  features: {
    deleteAccount:      false,
    muteConversation:   false,
    deleteConversation: false,
    blockUser:          false,
  },
  analytics: {
    enabled: true,
    matomoEndpoint: 'https://analytics.thomasfds.fr/matomo.php',
    siteId: 20,
    canonicalDomain: 'https://bluvy.app',
  },
};
