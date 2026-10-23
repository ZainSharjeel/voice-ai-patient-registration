// The auto sign-in intent param (`?viktor_sign_in=auto`), spent on arrival.
//
// One query param, two directions. Viktor surfaces (the dashboard space
// card, links Viktor shares in chat) and the Viktor edge gate append
// `viktor_sign_in=auto` so workspace members are signed in automatically on
// arrival; the OAuth callback page sets `viktor_sign_in=failed` when an
// attempt was denied, so the login page shows an explanation only when
// explicitly told to. Sharing the param makes intent and failure mutually
// exclusive on any URL.
//
// The intent is read once, here at module evaluation, and removed from the
// address bar at the same moment (the way `edgeHandoff.ts` consumes its
// cookie). Whatever `ViktorAutoSignIn` then does with it — enter the app,
// exchange the hand-off, start the OAuth round trip, or nothing because
// sign-in is unavailable or an attempt is in flight — the URL the visitor
// keeps, reloads, bookmarks or copies no longer asks for a sign-in, and a
// bfcache restore after backing out of the round trip finds it already gone.
//
// This module MUST evaluate before the router mounts. React Router only
// listens for `popstate`, so a `history.replaceState` it did not perform
// never reaches `useLocation`: the routes and the dashboard's embed bridge
// (which mirrors the current URL to the Knowledge sidebar) would keep
// seeing the spent param. `AuthStrategyRoutes.tsx` — in the entry chunk,
// rendered by App — imports this module for that side effect; every other
// auth module loads behind a lazy route chunk, after the router is up.

export const VIKTOR_SIGN_IN_PARAM = "viktor_sign_in";
export const VIKTOR_SIGN_IN_FAILED_VALUE = "failed";
export const VIKTOR_SIGN_IN_AUTO_VALUE = "auto";

export function hasAutoSignInIntentInSearch(search: string): boolean {
  return (
    new URLSearchParams(search).get(VIKTOR_SIGN_IN_PARAM) ===
    VIKTOR_SIGN_IN_AUTO_VALUE
  );
}

/** `pathname?search` with the spent intent param removed. Pure. */
export function stripAutoSignInIntent(
  pathname: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  params.delete(VIKTOR_SIGN_IN_PARAM);
  const remaining = params.toString();
  return `${pathname}${remaining ? `?${remaining}` : ""}`;
}

/**
 * Spend the intent param: report whether `location` carries it and, if so,
 * rewrite the address to the same page without it via `replaceUrl`. Pure
 * apart from that callback, so the browser wiring below stays a one-liner.
 */
export function consumeAutoSignInIntent(
  location: { pathname: string; search: string; hash: string },
  replaceUrl: (url: string) => void,
): boolean {
  if (!hasAutoSignInIntentInSearch(location.search)) return false;
  replaceUrl(
    `${stripAutoSignInIntent(location.pathname, location.search)}${location.hash}`,
  );
  return true;
}

// The OAuth round trip returns on a *new* page load whose URL never carries
// the param, so a denied attempt can never re-trigger itself.
const landedWithAutoSignInIntent =
  typeof window !== "undefined" &&
  consumeAutoSignInIntent(window.location, url => {
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // History access blocked (sandboxed frame): the param stays in the
      // address bar for this page load; the intent itself still fires once.
    }
  });

/** Whether this page load arrived from a Viktor surface asking for auto sign-in. */
export function pageLoadRequestedAutoSignIn(): boolean {
  return landedWithAutoSignInIntent;
}
