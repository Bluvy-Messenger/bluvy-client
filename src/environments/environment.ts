export const environment = {
  production:    false,
  version:       '1.0.15.6',
  apiUrl:        'http://localhost:3000',
  socketUrl:     'http://localhost:3000',
  oauthClientId: 'http://localhost',
  // aud for com.atproto.server.getServiceAuth — must match backend's ATPROTO_SERVICE_DID.
  oauthServiceDid: 'did:web:bluvy.app',
  // Web Push VAPID public key — safe to expose (paired private key stays
  // server-side only, see bluvy-backend/.env VAPID_PRIVATE_KEY).
  vapidPublicKey: 'BMRsiIEhGyXTJlrOKB5_I4sRnVc8OBHvRhpC6IaKKZ0b6KVGEAlDdi9ozHs-BRd_fUw2ZnINR0tBDFfCQo3aEDE',
  features: {
    deleteAccount:      false,
    muteConversation:   false,
    deleteConversation: false,
    blockUser:          false,
  },
};
