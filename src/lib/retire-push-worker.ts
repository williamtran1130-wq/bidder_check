export async function retirePushWorker(
  registrations: readonly ServiceWorkerRegistration[],
  origin: string,
) {
  await Promise.allSettled(registrations.map(async (registration) => {
    const workers = [registration.active, registration.waiting, registration.installing].filter((worker) => worker !== null);
    if (!workers.length || !workers.every((worker) => new URL(worker.scriptURL).origin === origin && new URL(worker.scriptURL).pathname === "/push-worker.js")) return;
    try {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } finally {
      await registration.unregister();
    }
  }));
}
