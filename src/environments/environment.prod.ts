export const environment = {
  production:    true,
  version:       '1.0.11',
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
};
