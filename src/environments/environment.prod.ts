export const environment = {
  production:    true,
  version:       '1.0.15.4',
  apiUrl:        'https://bluvy.app/api',
  socketUrl:     'https://bluvy.app',
  oauthClientId: 'https://bluvy.app/client-metadata.json',
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
