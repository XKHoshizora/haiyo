import React, { createContext, useContext, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from "react";
import * as routes from "../api/routes.js";
import { navAtStart } from "../state/location.js";
import { reducer } from "../state/reducer.js";
import { createActions } from "./actions.js";
import { initial, resetKeepingDrafts } from "./model.js";
import { httpTransport, start as startSync } from "./sync.js";
import { deadlinesOf, toView } from "./viewmodel.js";

const Ctx = createContext(null);

// UI state (navigation, toast) kept by the reducer. The data layer's view model is merged over it.
export function emptyState(me = null) {
  return {
    nav: {
      section: "chat",
      convId: null,
      view: "chat",
      profileTab: "members",
      detailsOpen: false,
      contactId: null,
      addFriend: false,
      opening: null,
      /** A message to scroll to and highlight once it is shown: {convId, seq, n}. */
      focus: null,
      /** The settings page shown: "profile" or "blocks". */
      settingsPage: "profile",
      /** The provider form shown on the providers page: "new", a provider id, or null (the list). */
      providerId: null,
      providerCreated: false,
      /** How the last move of the navigation enters the history: "push" or "replace" (state/reducer.js). */
      navIntent: "push",
      agentId: null,
      agentView: "detail",
      agentTab: "profile",
      pane: "list",
    },
    /** Conversations I left on purpose (this session): no notice when a Back arrives at their entry. */
    left: [],
    people: me ? { me } : {},
    agents: {},
    convs: {},
    order: [],
    relations: {},
    blocks: [],
    seq: 0,
    toast: null,
  };
}

/** The state a signed-in shell starts from: the empty one, its navigation already where the address is (state/location.js `navAtStart`). */
function startingState() {
  const empty = emptyState();
  return { ...empty, nav: { ...empty.nav, ...navAtStart() } };
}

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/**
 * The model, the sync engine and the actions behind the store. Nothing talks to the service until
 * `start()`; `stop()` closes the socket and cancels every timer, forgets what the service said and keeps
 * this account's drafts and unsent messages. Every dependency can be replaced (tests use fakes).
 */
export function createDataLayer({
  transport,
  api = routes,
  timers = defaultTimers,
  now = () => Date.now(),
  random = Math.random,
  uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  const tx = transport ?? httpTransport({ timers });
  let model = initial();
  let connection = "idle";
  /** The connection failed and has not been live since: shown as one failure line until it is, whichever attempt it is at (it flickers between connecting and reconnecting). */
  let failed = false;
  let snapshot = { model, connection, failed };
  let engine = null;
  let epoch = 0;
  let notified = false;
  const listeners = new Set();
  const signedOutListeners = new Set();

  const emit = () => {
    snapshot = { model, connection, failed };
    for (const fn of [...listeners]) fn();
  };
  const getModel = () => model;
  const setModel = (next) => {
    if (next === model) return;
    model = next;
    emit();
  };
  const setConnection = (next) => {
    if (next === connection) return;
    connection = next;
    if (next === "reconnecting") failed = true;
    else if (next === "live" || next === "idle") failed = false;
    emit();
  };

  function notifySignedOut() {
    engine = null;
    if (notified) return;
    notified = true;
    setConnection("signedOut");
    for (const fn of [...signedOutListeners]) {
      try {
        fn();
      } catch {
        /* a listener must not stop the others */
      }
    }
  }

  const { actions, reset: forgetRequests } = createActions({
    getModel,
    setModel,
    api,
    uuid,
    now,
    epoch: () => epoch,
    request: (needs) => engine?.request(needs),
    signedOut: () => (engine ? engine.signedOut() : notifySignedOut()),
  });

  return {
    actions,
    now,
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Called once when the session ended (socket close 4001, or a 401 answer). Returns an unsubscribe. */
    onSignedOut(fn) {
      signedOutListeners.add(fn);
      return () => signedOutListeners.delete(fn);
    },
    start() {
      if (engine) return;
      notified = false;
      if (model.synced) model = resetKeepingDrafts(model); // signed out without stop(): start from a first load
      engine = startSync(tx, { getModel, setModel, timers, now, random, onSignedOut: notifySignedOut, onStatus: setConnection });
    },
    stop() {
      epoch += 1;
      forgetRequests();
      const running = engine;
      engine = null;
      running?.stop();
      model = resetKeepingDrafts(model);
      connection = "idle";
      emit();
    },
  };
}

/**
 * `useStore()` → `{state, dispatch, actions, start, stop, onSignedOut}`. `state` is the view model merged
 * with the UI state; `dispatch` takes the UI actions (nav, toast). With `initialState` the store shows that
 * fixed state instead of the view model (render tests).
 */
export function StoreProvider({ children, initialState, dataLayer }) {
  const [layer] = useState(() => dataLayer ?? createDataLayer());
  const snapshot = useSyncExternalStore(layer.subscribe, layer.getSnapshot, layer.getSnapshot);
  const [ui, dispatch] = useReducer(reducer, initialState, (s) => s || startingState());
  // Moments the service sent at which an offer ends on screen (viewmodel.js `deadlinesOf`), on the wall clock (as the
  // service's are; `layer.now` is the clock the view's times are written with): the view is read again when one has
  // come — checked at every render (a tab woken from sleep is right at once), at the nearest one ahead (one
  // timer, cleared when it changes or on unmount, armed again after each wake: a timer that ran early, or one held to the
  // longest a timer waits, is set again), and when the tab is shown again.
  const [woken, wake] = useReducer((n) => n + 1, 0);
  const deadlines = useMemo(() => (initialState ? [] : deadlinesOf(snapshot.model)), [initialState, snapshot.model]);
  const at = Date.now();
  const come = deadlines.filter((ms) => ms <= at).length;
  const next = deadlines.reduce((soonest, ms) => (ms > at && ms < soonest ? ms : soonest), Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const handle = window.setTimeout(wake, Math.min(Math.max(0, next - Date.now()) + 1, 2_147_483_647));
    return () => window.clearTimeout(handle);
  }, [next, woken]);
  useEffect(() => {
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);
  const view = useMemo(
    () => (initialState ? null : toView(snapshot.model, { now: layer.now(), offersAt: Date.now() })),
    [initialState, snapshot.model, layer, come],
  );
  const state = useMemo(
    () => (view ? { ...ui, ...view, agentContacts: snapshot.model.agentContacts ?? null, connection: snapshot.connection, connectionFailed: snapshot.failed } : ui),
    [ui, view, snapshot.model.agentContacts, snapshot.connection, snapshot.failed],
  );

  useEffect(() => {
    if (!state.toast) return undefined;
    const id = state.toast.id;
    const handle = window.setTimeout(() => dispatch({ type: "toast/clear", id }), 4200);
    return () => window.clearTimeout(handle);
  }, [state.toast]);

  const value = useMemo(
    () => ({ state, dispatch, actions: layer.actions, start: layer.start, stop: layer.stop, onSignedOut: layer.onSignedOut }),
    [state, layer],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  return useContext(Ctx);
}
