// The one read of `GET /api/me/others-use` the screen shares (pages/useOthersUse.js), kept per data layer and forgotten when the layer stops
// (sign-out): nothing of an earlier session is ever shown under the next.
const stores = new WeakMap();

/** The shared read of the layer whose actions are `actions`. */
export function storeOf(actions) {
  let store = stores.get(actions);
  if (!store) {
    // `newest`: counts every answer that is newer than any read sent before it (a save's answer; a read asked for after a change).
    // A read keeps its answer only while the count is what it was when the read was SENT: an older read never overwrites a newer answer,
    // and its failure never marks a newer answer stale (`failed`).
    store = { use: null, failed: false, listeners: new Set(), pending: null, at: 0, forgotten: false, newest: 0 };
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
  // (A read asked for after a change: whatever is in flight was sent before it, and its answer is not kept.)
  if (afterWrite) store.newest += 1;
  const mine = (async () => {
    if (before) await before.catch(() => {});
    // What was newest when this read was SENT: its answer, or its failure, is news only while nothing newer has come since.
    const sentAt = store.newest;
    const outdated = () => store.forgotten || store.newest !== sentAt;
    try {
      const answer = await actions.getOthersUse();
      if (outdated()) return;
      if (answer && typeof answer === "object" && typeof answer.limit === "string") {
        store.use = answer;
        store.failed = false;
        store.at = Date.now();
      } else store.failed = true;
    } catch {
      // An older read that fails after a newer answer (a save's, a later read's) says nothing of it: that answer is not stale.
      if (!outdated()) store.failed = true;
    } finally {
      if (store.pending === mine) store.pending = null;
      store.listeners.forEach((fn) => fn());
    }
  })();
  store.pending = mine;
  return mine;
}


/**
 * A newer answer of the same shape than any read can bring (a save's own answer, a dismissed notice): a read still in flight does not
 * replace it. `next` may be a function of the answer held now (the freshest), so that what it changes is laid over that, never over
 * an older copy the caller held.
 */
export function settleOthersUse(store, next) {
  store.newest += 1;
  store.use = typeof next === "function" ? next(store.use) : next;
  store.failed = false;
  store.at = Date.now();
  store.listeners.forEach((fn) => fn());
}
