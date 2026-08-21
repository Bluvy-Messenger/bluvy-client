export const environment = {
  production:    true,
  version:       '1.0.15.5',
  apiUrl:        'https://bluvy.app/api',
  socketUrl:     'https://bluvy.app',
  oauthClientId: 'https://bluvy.app/client-metadata.json',
  // aud for com.atproto.server.getServiceAuth — must match backend's ATPROTO_SERVICE_DID.
  oauthServiceDid: 'did:web:bluvy.app',
  // Web Push VAPID public key — must match VAPID_PUBLIC_KEY in the
  // production backend's env. Generate a dedicated production pair with
  // `npx web-push generate-vapid-keys` (do not reuse the dev pair from
  // environment.ts). Empty until the team provisions one; Web Push
  // subscription is skipped client-side when unset.
  vapidPublicKey: '',
  features: {
    deleteAccount:      false,
    muteConversation:   false,
    deleteConversation: false,
    blockUser:          false,
  },
};
