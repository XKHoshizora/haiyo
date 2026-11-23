import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { readOthersUse, storeOf } from "../data/othersUseCache.js";

/**
 * One read of `GET /api/me/others-use` shared by everything on the screen that shows it (the list of my Agents and an Agent's page, which are
 * both drawn on a wide screen), per data layer: its answer as it came (`use`), `failed` when it could not be read. Nothing is kept in the
 * store and nothing outlives the layer. Reads that overlap are one request; `reload()` asks again. Nothing of it is computed here: the
 * numbers, the three states and the notice are the service's.
 */
/**
 * `maxAge`: on mount, an answer read less than that many milliseconds ago is used as it is (the list of my Agents and an Agent's page, drawn together
 * on a wide screen or one after the other, share one read); 0 (the default) reads again, as the use page and its line on the usage page do.
 */
export function useOthersUse({ maxAge = 0 } = {}) {
  const { actions } = useStore();
  const store = storeOf(actions);
  const [, rerender] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const fn = () => mounted.current && rerender((n) => n + 1);
    store.listeners.add(fn);
    if (maxAge === 0 || !store.use || Date.now() - store.at > maxAge) readOthersUse(actions, store);
    return () => {
      mounted.current = false;
      store.listeners.delete(fn);
    };
  }, [actions, store, maxAge]);
  const reload = useCallback((options) => readOthersUse(actions, store, options), [actions, store]);
  /** A newer answer of the same shape (a save's, a dismissed notice). */
  const settle = useCallback(
    (next) => {
      store.use = next;
      store.listeners.forEach((fn) => fn());
    },
    [store],
  );
  return { use: store.use, failed: store.failed, reload, settle };
}
