import React, { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as routes from "../api/routes.js";
import { bumpSessionEpoch, setTermsRequiredHandler, setUnauthenticatedHandler } from "../api/http.js";
import { createDataLayer } from "../data/store.jsx";
import { ChunkBoundary } from "../ui/ChunkBoundary.jsx";
import { AcceptTerms, Forgot, Loading, LoadFailed, Register, ResetPassword, SignIn, Verify } from "./screens.jsx";
import { forgetDrafts } from "../data/drafts.js";
import { captureResetToken, decide, navigate, parseRoute, rememberReturn, takeReturn, useLocation } from "./router.js";

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
      // An account that has not accepted the documents in force (GET /api/me `termsAccepted`) is asked first; until then the
      // app is not shown and its data layer does not run.
      setSession({ status: me?.termsAccepted === false ? "terms" : "in", expired: false });
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

  // A public page opens whatever the session is doing, also when the service cannot be reached.
  const decision = session.status === "failed" && route.name !== "legal" ? { view: "failed" } : decide(route, session.status);
  useEffect(() => {
    if (!decision.redirect) return;
    // A page of the app opened signed out is opened after the sign-in.
    if (decision.redirect === "/signin" && route.name === "app" && !wasIn.current) rememberReturn(globalThis.location.pathname);
    navigate(decision.redirect === "/" ? takeReturn() ?? "/" : decision.redirect, { replace: true });
  }, [decision.redirect]);

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
