import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as routes from "../api/routes.js";
import { bumpSessionEpoch, setTermsRequiredHandler, setUnauthenticatedHandler } from "../api/http.js";
import { createDataLayer } from "../data/store.jsx";
import { ChunkBoundary } from "../ui/ChunkBoundary.jsx";
import { AcceptTerms, Forgot, Loading, LoadFailed, Register, ResetPassword, SignIn, Verify } from "./screens.jsx";
import { forgetDrafts } from "../data/drafts.js";
import { captureResetToken, decide, navigate, parseRoute, rememberReturn, takeReturn, useLocation } from "./router.js";
import { pushSessionEnded, registerPush, unregisterPush } from "../shell/push.js";
import { startsInBackground, useOpenWhileSignedOut, useShellSession } from "../shell/useShell.js";

// The terms, the privacy policy and the contact page (src/legal/): a chunk of their own, loaded only when one is opened.
const LegalPage = lazy(() => import("../legal/LegalPage.jsx"));

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
    pushSessionEnded(); // (In the iOS shell: the badge goes; a no-op in a browser.)
    forgetDrafts(); // (What was typed in a form, an API key among it, does not outlive the session: gone at sign-out, not at the next shell.)
    setSession((s) => (s.status === "out" ? s : { status: "out", expired: wasExpired && s.status === "in" }));
  }, []);

  const confirm = useCallback(
    (me) => {
      const another = accountId.current !== null && accountId.current !== me.id;
      accountId.current = me.id;
      if (another) {
        // Nothing of the account before is kept: its layer (the old one is stopped as the new one starts), what was typed in its forms.
        forgetDrafts();
        const layer = createLayer();
        setBox((b) => ({ layer, id: b.id + 1 }));
      }
      bumpSessionEpoch();
      // An account that has not accepted the documents in force (GET /api/me `termsAccepted`) is asked first; until then the
      // app is not shown and its data layer does not run.
      // Only while the site requires them (`termsRequired`; false while the texts are drafts: nobody is asked).
      setSession({ status: me?.termsAccepted === false && me?.termsRequired !== false ? "terms" : "in", expired: false });
    },
    [createLayer],
  );
  const accepted = useCallback(() => setSession((s) => (s.status === "terms" ? { status: "in", expired: false } : s)), []);

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

  // The service refuses every signed-in request until the documents in force are accepted (403 terms_required): a tab that
  // was open when a new version came in asks too. Its data layer stops until the question is answered.
  useEffect(() => {
    setTermsRequiredHandler(() => setSession((s) => (s.status === "in" ? { status: "terms", expired: false } : s)));
    return () => setTermsRequiredHandler(null);
  }, []);

  // A tab that only shows a public page (the terms, opened from Settings in a new tab) runs no data layer: no socket for it.
  const running = session.status === "in" && route.name !== "legal";
  // Only a visit that was signed out from the start keeps the page it came for: a sign-out or an expiry must not hand the page of this
  // account to whoever signs in next.
  const wasIn = useRef(false);
  if (session.status === "in" || session.status === "terms") wasIn.current = true;
  useEffect(() => {
    if (!running) return undefined;
    const { layer } = box;
    const off = layer.onSignedOut(() => end(true));
    // A sync that answers for another account (someone else signed in in this browser): that account is confirmed here, as a
    // sign-in confirms one: its own layer, a new session epoch, everything bound to the account mounted again (`confirm`).
    const offAccount = layer.onAccountChanged?.((me) => confirm(me)) ?? (() => {});
    layer.start({ paused: startsInBackground(), accountId: accountId.current });
    return () => {
      off();
      offAccount();
      layer.stop();
    };
  }, [running, box, end, confirm]);
  // The iOS shell, when this page is in it (src/shell/): pause and resume of the socket, the phone's push registration.
  useShellSession({ running, layer: box.layer, api });

  const signOut = useCallback(async () => {
    signingOut.current = true;
    try {
      await unregisterPush(api); // (In the iOS shell: the phone is unbound and the badge cleared while the session still exists.)
      await api.signOut();
    } catch (error) {
      if (error?.status !== 401) {
        signingOut.current = false;
        registerPush(api); // (A sign-out that failed leaves the person signed in: the phone that was unbound for it is bound again.)
        return { ok: false, error };
      }
    }
    end(false);
    signingOut.current = false;
    return { ok: true };
  }, [api, end]);
  const sessionApi = useMemo(() => ({ signOut }), [signOut]);

  // A public page opens whatever the session is doing, also when the service cannot be reached.
  const decision = session.status === "failed" && route.name !== "legal" ? { view: "failed" } : decide(route, session.status);
  useEffect(() => {
    if (!decision.redirect) return;
    // A page of the app opened signed out is opened after the sign-in.
    if (decision.redirect === "/signin" && route.name === "app" && !wasIn.current) rememberReturn(globalThis.location.pathname);
    navigate(decision.redirect === "/" ? takeReturn() ?? "/" : decision.redirect, { replace: true });
  }, [decision.redirect]);

  // A tapped notification opened while signed out goes on after the sign-in, as a page of the app opened signed out does (a page that had a
  // signed-in account keeps nothing: the next sign-in may be another person's).
  useOpenWhileSignedOut(
    session.status === "out",
    useCallback((path) => {
      // Someone half-way through a register, a reset or a verification is not thrown back to the sign-in: the tap is dropped (it is only a
      // shortcut to a page; they are not signed in yet, and may be another person than the one it was meant for).
      const where = parseRoute(globalThis.location).name;
      if (where !== "app" && where !== "signin") return;
      if (!wasIn.current) rememberReturn(path);
      if (where !== "signin") navigate("/signin", { replace: true });
    }, []),
  );

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
    case "legal":
      return (
        <ChunkBoundary>
          <Suspense fallback={<Loading />}>
            <LegalPage doc={route.doc} />
          </Suspense>
        </ChunkBoundary>
      );
    case "accept":
      return <AcceptTerms api={api} onAccepted={accepted} onSignOut={signOut} />;
    case "signin":
      return <SignIn api={api} expired={session.expired} onSignedIn={confirm} />;
    case "register":
      return <Register api={api} />;
    case "verify":
      return <Verify api={api} error={route.error} signedIn={session.status === "in" || session.status === "terms"} />;
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
