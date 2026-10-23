import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { pageLoadEdgeHandoffToken } from "@/auth/edgeHandoff";
import {
  hasFreshViktorSignInAttempt,
  markViktorSignInAttempt,
  oauthCallbackUrl,
  pageLoadLandedPath,
  pageLoadRequestedAutoSignIn,
  rememberOAuthReturn,
} from "@/auth/oauthReturn";
import { getViktorSignInAvailable } from "@/lib/viktor-spaces-access/config";

export type AutoSignInAction =
  | "exchange_handoff"
  | "start_sign_in"
  | "enter_app"
  | "none";

// Convex Auth provider id of the edge-gate hand-off exchange
// (convex/viktorEdgeHandoffAuth.ts).
export const EDGE_HANDOFF_PROVIDER = "viktor_edge_handoff";

// The signing-in overlay also covers the initial session restore and the
// moment between a completed hand-off exchange and Convex confirming the
// new session, so a gated arrival never sees a sign-in form flash before
// being let in. If Convex Auth never settles (backend unreachable), the
// overlay lifts after this long and the page renders whatever it would have
// rendered anyway.
export const RESTORE_OVERLAY_GRACE_MS = 10_000;

/**
 * Lifecycle of the in-page hand-off exchange. `awaiting_session` is the
 * window after `signIn` resolved but before `useConvexAuth` reports the
 * session: the client has the tokens, the server has not confirmed them
 * yet. Rendering the routes in that window shows the anonymous login page
 * for a frame and, worse, lets the route guard bounce the deep link the
 * visitor opened to /login, from where the signed-in redirect lands on the
 * dashboard instead. The destination is carried here so the navigation can
 * wait for the session.
 */
export type HandoffExchangeState =
  | { status: "idle" }
  | { status: "exchanging" }
  | { status: "awaiting_session"; destination: string };

/**
 * Pure decision: is the full-screen signing-in overlay up? Everything that
 * is still on its way into the app is covered — the fallback OAuth redirect
 * leaving, the hand-off exchange in flight, the session it produced not yet
 * confirmed, and the initial session restore of a gated arrival. Each
 * waiting phase is bounded by the grace timer (`graceExpired`).
 */
export function shouldShowSigningInOverlay(state: {
  requestedAutoSignIn: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  redirecting: boolean;
  exchange: HandoffExchangeState["status"];
  graceExpired: boolean;
}): boolean {
  if (state.redirecting || state.exchange === "exchanging") return true;
  if (state.graceExpired) return false;
  if (state.exchange === "awaiting_session") return !state.isAuthenticated;
  return state.requestedAutoSignIn && state.isLoading;
}

export function getAutoSignInAvailability(): boolean {
  try {
    return getViktorSignInAvailable();
  } catch {
    // An invalid provider list must never trigger OAuth. The login page owns
    // the visible configuration error while this automatic path stays inert.
    return false;
  }
}

/**
 * Pure decision for the auto sign-in intent param (`viktor_sign_in=auto`).
 *
 * Only links from Viktor surfaces carry the param, so the visitor is almost
 * certainly a signed-in workspace member. Three ways to honor it, cheapest
 * first: a stored session (enter the app), the edge gate's hand-off token
 * (one server-side exchange, no navigation), and finally the full "Sign in
 * with Viktor" OAuth round trip. The param itself is already gone from the
 * address bar by the time this runs (`autoSignInIntent.ts` strips it at
 * module evaluation, before the router mounts), so none of these paths —
 * nor a "none" — has to clean up after it. The round trip is still loop-proof: it fires at most once per
 * page load, never while a recent attempt is in flight, and its return leg
 * lands on a URL without the param — a denial ends on the login page with
 * the explicit failure message, never in a retry.
 */
// Entry routes where an authenticated "enter_app" arrival should move into
// the app. Anywhere else the intent link was a deep link: the visitor is
// already signed in and the page itself is the destination, so bouncing to
// the dashboard would discard the path the edge gate just restored.
const ENTRY_ROUTES = new Set(["/", "/login", "/signup"]);

/**
 * Where an already-authenticated auto sign-in arrival should land: the
 * dashboard from an entry route, or `null` to stay on the current (deep-link)
 * page.
 */
export function resolveEnterAppDestination(pathname: string): string | null {
  return ENTRY_ROUTES.has(pathname) ? "/dashboard" : null;
}

/**
 * Where a sign-in completed in-page (the hand-off exchange) should land:
 * the dashboard when the visitor opened an entry route, otherwise the deep
 * link they opened — which the route guard bounced to /login while they
 * were still anonymous.
 */
export function resolveHandoffDestination(landedPath: string): string {
  const pathname = new URL(landedPath, "https://space.local").pathname;
  return resolveEnterAppDestination(pathname) ?? landedPath;
}

export function resolveAutoSignInAction(state: {
  requestedAutoSignIn: boolean;
  signInAvailable: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  hasRecentAttempt: boolean;
  hasHandoffToken: boolean;
}): AutoSignInAction {
  if (!state.requestedAutoSignIn) return "none";
  // Wait for Convex Auth to restore any existing session before deciding.
  if (state.isLoading) return "none";
  // Already signed in (a returning member re-opening a shared link): honor
  // the intent by entering the app instead of restarting the OAuth flow.
  if (state.isAuthenticated) return "enter_app";
  if (!state.signInAvailable) return "none";
  // The edge gate verified this member moments ago and handed over a
  // single-use token: sign in right here, no navigation. Not subject to the
  // attempt marker — that guards the redirect loop, and this never redirects.
  if (state.hasHandoffToken) return "exchange_handoff";
  if (state.hasRecentAttempt) return "none";
  return "start_sign_in";
}

/**
 * Acts on the auto sign-in intent param. Mounted once inside the Convex Auth
 * provider (outside the routes) so it works no matter which page a shared
 * link lands on. Renders a full-screen signing-in overlay from the moment a
 * gated arrival lands until they are in (or the fallback OAuth redirect is
 * leaving); renders nothing otherwise.
 */
export function ViktorAutoSignIn({
  requestedAutoSignIn = pageLoadRequestedAutoSignIn(),
  handoffToken = pageLoadEdgeHandoffToken(),
  landedPath = pageLoadLandedPath(),
}: {
  requestedAutoSignIn?: boolean;
  handoffToken?: string | null;
  landedPath?: string;
}) {
  const { signIn } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const navigate = useNavigate();
  const actedRef = useRef(false);
  // The hand-off token is spent exactly once; a fallback OAuth start after a
  // failed exchange must not present it again.
  const handoffRef = useRef<string | null>(handoffToken);
  const [redirecting, setRedirecting] = useState(false);
  const [exchange, setExchange] = useState<HandoffExchangeState>({
    status: "idle",
  });
  const [graceExpired, setGraceExpired] = useState(false);

  useEffect(() => {
    // Backing out of the OAuth redirect can restore this page from the
    // back-forward cache with its JS state frozen mid-attempt: the
    // signing-in overlay stuck on screen and `actedRef` blocking any further
    // action. On restore, drop the overlay and re-arm. This cannot restart
    // the OAuth flow by itself (the decision effect re-runs only when auth
    // state changes, and the fresh attempt marker vetoes a restart anyway) —
    // it just lets a completed sign-in proceed into the app.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      actedRef.current = false;
      setRedirecting(false);
      setExchange({ status: "idle" });
      setGraceExpired(false);
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // One grace budget per waiting phase: the initial session restore, and
  // the wait for Convex to confirm a hand-off session. Entering a phase
  // clears any earlier expiry and arms a fresh timer; reaching the app (or
  // giving up) clears the timer.
  const waitingForSession =
    (requestedAutoSignIn && isLoading) ||
    (exchange.status === "awaiting_session" && !isAuthenticated);
  useEffect(() => {
    if (!waitingForSession) return;
    setGraceExpired(false);
    const timer = setTimeout(
      () => setGraceExpired(true),
      RESTORE_OVERLAY_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [waitingForSession]);

  useEffect(() => {
    // The hand-off exchange completed and Convex now reports the session:
    // move to the page the visitor opened. Deferred until here so the route
    // guard sees an authenticated visitor. If ProtectedRoute already bounced
    // the anonymous visitor to /login, PublicOnlyRoute's own redirect fires
    // in this same commit — to the bounced-from page it recorded, which is
    // this destination (both derive from the landed URL), so neither can
    // win the deep link away from the other.
    if (exchange.status !== "awaiting_session" || !isAuthenticated) return;
    setExchange({ status: "idle" });
    navigate(exchange.destination, { replace: true });
  }, [exchange, isAuthenticated, navigate]);

  useEffect(() => {
    if (actedRef.current) return;
    const action = resolveAutoSignInAction({
      requestedAutoSignIn,
      signInAvailable: getAutoSignInAvailability(),
      isAuthenticated,
      isLoading,
      hasRecentAttempt: hasFreshViktorSignInAttempt(),
      hasHandoffToken: handoffRef.current !== null,
    });
    if (action === "none") return;
    actedRef.current = true;
    if (action === "enter_app") {
      // The location is read imperatively at act time, not subscribed via
      // useLocation: the decision effect must re-run only on auth changes,
      // or a bfcache restore's re-arm would let a later in-app navigation
      // re-fire enter_app and bounce an entry route to the dashboard.
      const destination = resolveEnterAppDestination(window.location.pathname);
      if (destination !== null) {
        navigate(destination, { replace: true });
      }
      // Deep link: the page itself is the destination; nothing to do.
      return;
    }
    const startOAuthRoundTrip = () => {
      setRedirecting(true);
      markViktorSignInAttempt();
      rememberOAuthReturn();
      signIn("viktor", {
        redirectTo: oauthCallbackUrl(),
      }).catch(() => {
        // Couldn't even start the redirect (misconfiguration, network): drop
        // the overlay and let the page render normally — the login page still
        // offers the manual button.
        setRedirecting(false);
      });
    };
    if (action === "exchange_handoff") {
      const token = handoffRef.current;
      handoffRef.current = null;
      if (token === null) return;
      setExchange({ status: "exchanging" });
      signIn(EDGE_HANDOFF_PROVIDER, { session_token: token })
        .then(result => {
          if (!result.signingIn) {
            throw new Error("edge hand-off exchange did not sign in");
          }
          // Signed in without leaving the page. The client holds the tokens
          // now, but `useConvexAuth` only reports the session once the server
          // has confirmed them; the overlay stays up and the navigation to
          // the page the visitor opened waits for that (effect above).
          setExchange({
            status: "awaiting_session",
            destination: resolveHandoffDestination(landedPath),
          });
        })
        .catch(() => {
          // Expired (a slow load past the token's lifetime), already spent, or
          // refused: the ordinary round trip still works and is loop-proof.
          setExchange({ status: "idle" });
          if (hasFreshViktorSignInAttempt()) return;
          startOAuthRoundTrip();
        });
      return;
    }
    startOAuthRoundTrip();
  }, [
    requestedAutoSignIn,
    isAuthenticated,
    isLoading,
    landedPath,
    navigate,
    signIn,
  ]);

  const overlay = shouldShowSigningInOverlay({
    requestedAutoSignIn,
    isAuthenticated,
    isLoading,
    redirecting,
    exchange: exchange.status,
    graceExpired,
  });
  if (!overlay) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Signing you in...</p>
    </div>
  );
}
