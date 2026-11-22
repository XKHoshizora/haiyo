import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as routes from "../api/routes.js";
import { bumpSessionEpoch, setUnauthenticatedHandler } from "../api/http.js";
import { createDataLayer } from "../data/store.jsx";
import { Forgot, Loading, LoadFailed, Register, ResetPassword, SignIn, Verify } from "./screens.jsx";
import { forgetDrafts } from "../data/drafts.js";
import { captureResetToken, decide, navigate, parseRoute, rememberReturn, takeReturn, useLocation } from "./router.js";

const SessionContext = createContext(null);

/** `{ signOut() → Promise<{ok, error?}> }`, or null outside the sign-in gate (render tests). */
export const useSession = () => useContext(SessionContext);

/**
 * Decides signed in or out (one `GET /api/me` at start), shows the account screens or, for a signed-in user,
 * `children(dataLayer, key)`. While a session is confirmed the data layer runs; it is stopped when the session
 * ends (sign-out, a 401 on a non-auth request, socket close 4001). Unsent drafts stay in the layer for this tab
 * and the same account; another account gets a fresh layer.
 */
export function AuthRoot({ api = routes, createLayer = createDataLayer, children }) {
  useState(captureResetToken); // first: the reset token leaves the address bar before any request is made
  const location = useLocation();
  const route = useMemo(() => parseRoute(location), [location]);
  const [box, setBox] = useState(() => ({ layer: createLayer(), id: 0 }));
  const [session, setSession] = useState({ status: "loading", expired: false });
  const accountId = useRef(null);
  const requested = useRef(false);

  const signingOut = useRef(false);

  const end = useCallback((expired) => {
    // The service closes our socket with 4001 on a deliberate sign-out too; that is not an expiry.
    const wasExpired = expired && !signingOut.current;
    bumpSessionEpoch();
    forgetDrafts(); // (What was typed in a form, an API key among it, does not outlive the session: gone at sign-out, not at the next shell.)
    setSession((s) => (s.status === "out" ? s : { status: "out", expired: wasExpired && s.status === "in" }));
  }, []);

  const confirm = useCallback(
    (me) => {
      const another = accountId.current !== null && accountId.current !== me.id;
      accountId.current = me.id;
      if (another) {
        const layer = createLayer();
        setBox((b) => ({ layer, id: b.id + 1 }));
      }
      bumpSessionEpoch();
      setSession({ status: "in", expired: false });
    },
    [createLayer],
  );

  const loadMe = useCallback(() => {
    api.getMe().then(confirm, (err) => (err?.status === 401 ? end(false) : setSession({ status: "failed", expired: false })));
  }, [api, confirm, end]);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    setUnauthenticatedHandler(() => end(true));
    return () => setUnauthenticatedHandler(null);
  }, [end]);

  const running = session.status === "in";
  // Only a visit that was signed out from the start keeps the page it came for: a sign-out or an expiry must not hand the page of this
  // account to whoever signs in next.
  const wasIn = useRef(false);
  if (running) wasIn.current = true;
  useEffect(() => {
    if (!running) return undefined;
    const { layer } = box;
    const off = layer.onSignedOut(() => end(true));
    layer.start();
    return () => {
      off();
      layer.stop();
    };
  }, [running, box, end]);

  const signOut = useCallback(async () => {
    signingOut.current = true;
    try {
      await api.signOut();
    } catch (error) {
      if (error?.status !== 401) {
        signingOut.current = false;
        return { ok: false, error };
      }
    }
    end(false);
    signingOut.current = false;
    return { ok: true };
  }, [api, end]);
  const sessionApi = useMemo(() => ({ signOut }), [signOut]);

  const decision = session.status === "failed" ? { view: "failed" } : decide(route, session.status);
  useEffect(() => {
    if (!decision.redirect) return;
    // A page of the app opened signed out is opened after the sign-in.
    if (decision.redirect === "/signin" && route.name === "app" && !wasIn.current) rememberReturn(globalThis.location.pathname);
    navigate(decision.redirect === "/" ? takeReturn() ?? "/" : decision.redirect, { replace: true });
  }, [decision.redirect]);

  // A change of account screen (a link from 注册 to 登录) takes the control that was pressed with the old screen: the focus goes to
  // the new screen's heading, which names it. (The first screen of a visit is left alone.)
  const shownView = useRef(null);
  useLayoutEffect(() => {
    const was = shownView.current;
    shownView.current = decision.view;
    if (!was || was === decision.view || decision.view === "app" || decision.view === "loading") return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const heading = document.querySelector(".auth-card h1");
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }, [decision.view]);

  switch (decision.view) {
    case "app":
      return <SessionContext.Provider value={sessionApi}>{children(box.layer, box.id)}</SessionContext.Provider>;
    case "signin":
      return <SignIn api={api} expired={session.expired} onSignedIn={confirm} />;
    case "register":
      return <Register api={api} />;
    case "verify":
      return <Verify api={api} error={route.error} signedIn={running} />;
    case "forgot":
      return <Forgot api={api} />;
    case "reset":
      return <ResetPassword api={api} />;
    case "failed":
      return (
        <LoadFailed
          onRetry={() => {
            setSession({ status: "loading", expired: false });
            loadMe();
          }}
        />
      );
    default:
      return <Loading />;
  }
}
