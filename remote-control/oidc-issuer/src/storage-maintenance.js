export const PRUNE_INTERVAL_MS = 30_000;

// One scheduler per HTTP application, shared by all provider and browser models.
export function startStorageMaintenance(store) {
  // A startup write failure must prevent the app from becoming available.
  store.prune();
  let failed = false, closed = false;
  const timer = setInterval(() => {
    if (closed || failed) return;
    try { store.prune(); }
    catch {
      failed = true;
      clearInterval(timer);
    }
  }, PRUNE_INTERVAL_MS);
  timer.unref();
  return {
    health() {
      if (failed || closed) throw new Error('Issuer storage maintenance unavailable');
    },
    close() {
      closed = true;
      clearInterval(timer);
    }
  };
}
