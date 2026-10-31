// Temporary retirement worker: keep this URL while existing clients update.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const subscription = await self.registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } finally {
      await self.registration.unregister();
    }
  })());
});
