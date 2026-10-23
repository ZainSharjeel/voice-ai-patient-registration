// OAuth return detection for "Sign in with Viktor".
//
// A successful authorize round trip lands back in the app with ?code=... in
// the URL; a denial lands without one. Convex Auth's provider consumes the
// code and strips it from the URL as soon as it mounts, and components can
// mount at any point relative to that — so both return signals are captured
// once at module-evaluation time (strictly before any component mounts or
// provider effect runs) and exposed as page-load constants.

import {
  stripAutoSignInIntent,
  VIKTOR_SIGN_IN_FAILED_VALUE,
  VIKTOR_SIGN_IN_PARAM,
} from "./autoSignInIntent";

// The intent param itself (`viktor_sign_in=auto`) lives in
// `autoSignInIntent.ts`, which spends it before the router mounts; its
// constants and helpers are re-exported here for the modules that read the
// `failed` direction or derive paths from a landed URL.
export {
  consumeAutoSignInIntent,
  hasAutoSignInIntentInSearch,
  pageLoadRequestedAutoSignIn,
  stripAutoSignInIntent,
  VIKTOR_SIGN_IN_AUTO_VALUE,
  VIKTOR_SIGN_IN_FAILED_VALUE,
  VIKTOR_SIGN_IN_PARAM,
} from "./autoSignInIntent";

export const OAUTH_CALLBACK_PATH = "/auth/callback";

export function oauthCallbackUrl(): string {
  return new URL(OAUTH_CALLBACK_PATH, window.location.origin).href;
}
export const LOGIN_FAILED_PATH = `/login?${VIKTOR_SIGN_IN_PARAM}=${VIKTOR_SIGN_IN_FAILED_VALUE}`;

// Marks an in-flight Viktor OAuth round trip so a denied return (which
// carries no code) can be told apart from a stray direct visit, and so an
// automatic attempt is never restarted while a recent one is in flight
// (e.g. after backing out of the Viktor sign-in page into a cached copy of
// the page that started it).
const ATTEMPT_STORAGE_KEY = "viktor-spaces:viktor-signin-attempt";
const ATTEMPT_TTL_MS = 5 * 60 * 1000;

export function hasOAuthCodeInSearch(search: string): boolean {
  return new URLSearchParams(search).has("code");
}

export function markViktorSignInAttempt(): void {
  try {
    sessionStorage.setItem(ATTEMPT_STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage unavailable — a denied return will land on the plain login
    // page without the explanatory message.
  }
}

function attemptMarkerIsFresh(raw: string | null): boolean {
  if (raw === null) return false;
  const startedAt = Number(raw);
  return Number.isFinite(startedAt) && Date.now() - startedAt < ATTEMPT_TTL_MS;
}

/**
 * Whether a recent sign-in attempt is (or may still be) in flight. Peeks
 * without consuming: the callback route owns consumption.
 */
export function hasFreshViktorSignInAttempt(): boolean {
  try {
    return attemptMarkerIsFresh(sessionStorage.getItem(ATTEMPT_STORAGE_KEY));
  } catch {
    return false;
  }
}

function consumeFreshAttemptMarker(): boolean {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_STORAGE_KEY);
    if (raw === null) return false;
    sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
    return attemptMarkerIsFresh(raw);
  } catch {
    return false;
  }
}

const landedWithOAuthCode =
  typeof window !== "undefined" && hasOAuthCodeInSearch(window.location.search);

// Router state the protected-route guard attaches when it bounces an
// anonymous visitor to /login: the page they were on. The public-only guard
// sends a visitor who signs in back there instead of to the dashboard, so a
// deep link survives an in-page sign-in that completes after the bounce.
export const BOUNCED_FROM_STATE_KEY = "from";

const RETURN_STORAGE_KEY = "viktor-spaces:oauth-return";

export function rememberOAuthReturn(path = pageLoadLandedPath()): void {
  try {
    const pathname = path.split("?")[0];
    if (["/login", "/signup", OAUTH_CALLBACK_PATH].includes(pathname)) return;
    sessionStorage.setItem(RETURN_STORAGE_KEY, path);
  } catch {
    // OAuth still works without storage, returning to the dashboard.
  }
}

export function clearOAuthReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_STORAGE_KEY);
  } catch {
    // Storage is optional.
  }
}

export function readOAuthReturn(): string {
  try {
    const value = sessionStorage.getItem(RETURN_STORAGE_KEY);
    const url = new URL(value || "", "https://space.invalid");
    if (
      url.origin === "https://space.invalid" &&
      !["/", "/login", "/signup", OAUTH_CALLBACK_PATH].includes(url.pathname)
    ) {
      return url.pathname + url.search;
    }
  } catch {
    // Invalid or unavailable storage cannot redirect outside the app.
  }
  return "/dashboard";
}

/** Where a visitor who just signed in on a public-only route should land. */
export function resolveSignedInReturn(routerState: unknown): string {
  if (typeof routerState === "object" && routerState !== null) {
    const from = (routerState as Record<string, unknown>)[
      BOUNCED_FROM_STATE_KEY
    ];
    // Only an in-app path is honored; the state is caller-supplied history.
    if (
      typeof from === "string" &&
      from.startsWith("/") &&
      !from.startsWith("//")
    ) {
      return from;
    }
  }
  return "/dashboard";
}

// The page the visitor actually opened, captured before any route guard can
// bounce an unauthenticated arrival to /login (which drops the path and the
// query). An in-page sign-in that completes later returns here, so a gated
// deep link survives the sign-in instead of collapsing to the dashboard.
const landedPath =
  typeof window !== "undefined"
    ? stripAutoSignInIntent(window.location.pathname, window.location.search)
    : "/";

// Only the callback route is the return leg of an attempt, so the marker is
// consumed only there — a second tab or a stray /login visit while the OAuth
// round trip is in flight must not eat the marker and rob the real return of
// its denied-attempt context.
const returnedFromAttempt =
  typeof window !== "undefined" &&
  window.location.pathname === OAUTH_CALLBACK_PATH &&
  consumeFreshAttemptMarker();

/** Whether this page load arrived carrying an OAuth verification code. */
export function pageLoadHadOAuthCode(): boolean {
  return landedWithOAuthCode;
}

/** Whether this page load is the return leg of a recent sign-in attempt. */
export function pageLoadReturnedFromViktorSignIn(): boolean {
  return returnedFromAttempt;
}

/** The path (with query, minus the intent param) this page load opened. */
export function pageLoadLandedPath(): string {
  return landedPath;
}
