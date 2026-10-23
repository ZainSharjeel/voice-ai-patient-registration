import { useConvexAuth } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import {
  clearOAuthReturn,
  LOGIN_FAILED_PATH,
  pageLoadHadOAuthCode,
  pageLoadReturnedFromViktorSignIn,
  readOAuthReturn,
} from "@/auth/oauthReturn";

// A successful return carries ?code=... that Convex Auth exchanges in the
// background. If no session materialized after this long, treat the attempt
// as failed instead of spinning forever.
const CODE_EXCHANGE_GRACE_MS = 10_000;

/**
 * Pure routing decision for the OAuth return leg; `null` means "stay on the
 * signing-in screen".
 */
export function resolveOAuthCallbackDestination(state: {
  isAuthenticated: boolean;
  isLoading: boolean;
  hadOAuthCode: boolean;
  returnedFromSignIn: boolean;
  timedOut: boolean;
  destination?: string;
}): string | null {
  if (state.isAuthenticated) return state.destination ?? "/dashboard";
  if (!state.isLoading && !state.hadOAuthCode) {
    // No code means the round trip ended without a grant: a denial when we
    // just left for one (fresh attempt marker), a stray visit otherwise.
    return state.returnedFromSignIn ? LOGIN_FAILED_PATH : "/login";
  }
  if (state.timedOut) return LOGIN_FAILED_PATH;
  return null;
}

/**
 * Landing route for the "Sign in with Viktor" OAuth return leg
 * (an absolute `/auth/callback` URL on the initiating hostname). It renders a
 * neutral signing-in screen while Convex Auth exchanges the verification
 * code, then routes to the app on success or to the login page — with an
 * explicit failure param — when the attempt was denied. Keeping the return
 * leg on its own route means the login page never has to interpret a
 * transient unauthenticated state, so no failure message can flash during a
 * successful sign-in.
 */
export function ViktorOAuthCallbackPage({
  hadOAuthCode = pageLoadHadOAuthCode(),
  returnedFromSignIn = pageLoadReturnedFromViktorSignIn(),
}: {
  hadOAuthCode?: boolean;
  returnedFromSignIn?: boolean;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [timedOut, setTimedOut] = useState(false);
  const [destination] = useState(readOAuthReturn);

  useEffect(() => {
    if (isAuthenticated) clearOAuthReturn();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!hadOAuthCode || isAuthenticated) return;
    const timer = setTimeout(() => setTimedOut(true), CODE_EXCHANGE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [hadOAuthCode, isAuthenticated]);

  const resolved = resolveOAuthCallbackDestination({
    isAuthenticated,
    isLoading,
    hadOAuthCode,
    returnedFromSignIn,
    timedOut,
    destination,
  });
  if (resolved !== null) {
    return <Navigate to={resolved} replace />;
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Signing you in...</p>
    </div>
  );
}
