// Wraps the Angular-generated service worker (asset caching, kept exactly as
// Angular built it) and adds Web Push handling on top. Registered in place of
// 'ngsw-worker.js' directly — see main.ts's provideServiceWorker() call.
importScripts('./ngsw-worker.js');

// Payload shape is produced by bluvy-backend's push.service.ts
// (sendWebPushBatch/sendSilentWakeupToDevice) — always minimal, never
// plaintext message content. Only 'new_message' surfaces a notification;
// other types (e.g. the MLS key-package silent refill) are intentionally
// silent here, matching the native app's behavior for the same payload.
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  if (payload.type !== 'new_message') return;

  event.waitUntil(
    (async () => {
      // Dedup against Socket.IO: if a window is focused, the app is actively
      // in front of the user and NotificationService's own global
      // messageNew$ subscriber (independent of which page is open) has
      // already surfaced this message in-app -- a system notification on
      // top would be redundant. Not used to suppress based on "conversation
      // exists locally" (that's true for every message ever received, and
      // would wrongly hide genuinely new ones) -- only live focus, a much
      // narrower and more accurate signal.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((client) => client.focused)) return;

      const title = payload.title || 'Bluvy';
      const options = {
        body: 'New message',
        icon: '/assets/icons/icon-192.webp',
        badge: '/assets/icons/icon-192.webp',
        tag: payload.conversationId, // collapses rapid repeat pushes for the same conversation into one notification
        renotify: true,
        data: { conversationId: payload.conversationId, messageId: payload.messageId },
      };
      await self.registration.showNotification(title, options);
    })(),
  );
});

// Mirrors PushNotificationService's native pushNotificationActionPerformed:
// focus an already-open tab and hand it the conversationId to navigate to,
// or open a fresh one at the conversation's URL if nothing is open.
self.addEventListener('notificationclick', (event) => {
  const conversationId = event.notification.data?.conversationId;
  event.notification.close();

  const targetPath = conversationId ? `/conversations/${conversationId}` : '/conversations';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'bluvy-notification-click', conversationId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetPath);
      }
    }),
  );
});

// Subscription renewal: the browser can invalidate/replace a subscription at
// any time (key rotation, expiry). The service worker has no access to the
// app's auth session to re-upload it here, so this is intentionally a no-op
// beyond logging — PushNotificationService re-validates and re-uploads the
// subscription on every app launch instead (see initialize()).
self.addEventListener('pushsubscriptionchange', () => {
  // eslint-disable-next-line no-console
  console.log('[SW] pushsubscriptionchange — will be reconciled on next app launch');
});
