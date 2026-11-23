// The one read of `GET /api/me/others-use` the screen shares (pages/useOthersUse.js), kept per data layer and forgotten when the layer stops
// (sign-out): nothing of an earlier session is ever shown under the next.
const stores = new WeakMap();

/** The shared read of the layer whose actions are `actions`. */
export function storeOf(actions) {
  let store = stores.get(actions);
  if (!store) {
    store = { use: null, failed: false, listeners: new Set(), pending: null, at: 0, forgotten: false };
    stores.set(actions, store);
  }
  return store;
}

/** The layer stopped: its answer is dropped, a read still in flight is ignored, and the next screen starts empty. */
export function forgetOthersUse(actions) {
  const store = stores.get(actions);
  if (!store) return;
  store.use = null;
  store.failed = false;
  store.at = 0;
  store.pending = null;
  store.forgotten = true;
  stores.delete(actions);
  store.listeners.forEach((fn) => fn());
}


/**
 * A read; one already in flight is the one handed back, unless `afterWrite`: a read asked for after a write must start after anything in flight
 * (that one may have been sent before the write and answer with what it was), so it waits for it and reads again.
 */
export function readOthersUse(actions, store, { afterWrite = false } = {}) {
  if (store.pending && !afterWrite) return store.pending;
  const before = store.pending;
  const mine = (async () => {
    if (before) await before.catch(() => {});
    try {
      const answer = await actions.getOthersUse();
      if (store.forgotten) return;
      if (answer && typeof answer === "object" && answer.limits) {
        store.use = answer;
        store.failed = false;
        store.at = Date.now();
      } else store.failed = true;
    } catch {
      store.failed = true;
    } finally {
      if (store.pending === mine) store.pending = null;
      store.listeners.forEach((fn) => fn());
    }
  })();
  store.pending = mine;
  return mine;
}

