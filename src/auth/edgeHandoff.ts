// Edge-gate → app sign-in hand-off.
//
// When a workspace member reaches this app through the Viktor edge gate, the
// gate has just verified their identity with Viktor. Instead of making the
// app repeat that verification with its own "Sign in with Viktor" OAuth
// round trip (four more navigations), the gate hands the app a short-lived,
// single-use Viktor space session token in a host-only cookie on the redirect
// back into the app. The `viktor_edge_handoff` Convex Auth provider trades it
// for the app's own session with one server-side call, so the member is
// signed in without leaving the page.
//
// The cookie is read and cleared once, at module-evaluation time — before any
// component mounts — so the token is never left lying in `document.cookie`
// for the rest of the page's life, and a later in-app navigation or reload
// can never re-trigger the exchange. The backend revokes the token on its
// first successful exchange regardless.

// Shared contract with the edge-gate worker (SPACE_HANDOFF_COOKIE in
// backend/viktor/edge_gate/worker/index.ts) — keep in sync.
export const SPACE_HANDOFF_COOKIE = "__Host-viktor_space_handoff";

// Backend-minted tokens are URL-safe alphanumerics; anything else in the
// cookie is not ours and is ignored rather than sent to the backend.
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

/** The hand-off token in a `document.cookie` string, or null. Pure. */
export function readHandoffTokenFromCookies(
  cookieString: string,
): string | null {
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SPACE_HANDOFF_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return HANDOFF_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

/** Set-Cookie value that expires the hand-off cookie on this host. */
export function clearHandoffCookieValue(): string {
  // `__Host-` cookies can only be cleared with the exact attributes they were
  // set with: Path=/, Secure, no Domain.
  return `${SPACE_HANDOFF_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

function consumeHandoffCookie(): string | null {
  if (typeof document === "undefined") return null;
  let token: string | null = null;
  try {
    token = readHandoffTokenFromCookies(document.cookie);
    if (token !== null) {
      // The Cookie Store API is async and missing in Safari/Firefox; the
      // synchronous assignment is what lets the token be consumed here, at
      // module evaluation, before any component can observe it.
      // biome-ignore lint/suspicious/noDocumentCookie: synchronous single-use consumption at module eval
      document.cookie = clearHandoffCookieValue();
    }
  } catch {
    // Cookie access blocked (sandboxed frame): behave as if none was sent.
    return null;
  }
  return token;
}

const pageLoadHandoffToken = consumeHandoffCookie();

/**
 * The single-use hand-off token this page load arrived with, or null. The
 * cookie itself is already cleared; the value lives only in this module.
 */
export function pageLoadEdgeHandoffToken(): string | null {
  return pageLoadHandoffToken;
}
