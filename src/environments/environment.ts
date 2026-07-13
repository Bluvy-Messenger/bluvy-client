export const environment = {
  production:    false,
  version:       '1.0.12',
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
};
