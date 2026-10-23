import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useEffect, useRef } from "react";

// Automation and authenticated-screenshot sign-in bootstrap.
//
// The Viktor backend mints a short-lived space-session token (only for a
// tool-token holder: the agent sandbox and the e2e/screenshot runners) and
// places it in sessionStorage before the app loads. Here we exchange it for a
// Convex Auth session through the `space_session` provider, which validates the
// token server-side.
//
// This cannot sign a real user in: the token is non-forgeable and is never
// issued to a browser visitor, and sessionStorage cannot be set through a
// shared link, so on a normal visit `readToken()` returns null and this is a
// no-op. It replaces the old "Continue as Test User" button.
const SPACE_SESSION_TOKEN_KEY = "viktor_space_session_token";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(SPACE_SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(SPACE_SESSION_TOKEN_KEY);
  } catch {
    // sessionStorage is unavailable (private mode, sandbox) — nothing to clear.
  }
}

export function SpaceSessionAutoSignIn() {
  const { signIn } = useAuthActions();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const actedRef = useRef(false);

  useEffect(() => {
    if (actedRef.current) return;
    // Wait for Convex Auth to restore any existing session before deciding.
    if (isLoading || isAuthenticated) return;
    const token = readToken();
    if (!token) return;
    actedRef.current = true;
    signIn("space_session", { session_token: token })
      .catch(() => {
        // A denied or expired token leaves the app on the login page, the same
        // as any other failed sign-in. Nothing to retry here.
      })
      .finally(clearToken);
  }, [isAuthenticated, isLoading, signIn]);

  return null;
}
