import { useConvexAuth } from "convex/react";
import { Navigate, Outlet, useLocation } from "react-router";
import {
  BOUNCED_FROM_STATE_KEY,
  stripAutoSignInIntent,
} from "@/auth/oauthReturn";
export function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const location = useLocation();

  if (isLoading) {
    return <p role="status">Signing you in...</p>;
  }

  if (!isAuthenticated) {
    // Carry the page being left so PublicOnlyRoute can return a visitor who
    // signs in on /login (e.g. the edge hand-off completing) to it, not to
    // the dashboard. The intent param is spent on arrival and never returns.
    return (
      <Navigate
        to="/login"
        replace
        state={{
          [BOUNCED_FROM_STATE_KEY]: stripAutoSignInIntent(
            location.pathname,
            location.search,
          ),
        }}
      />
    );
  }

  return <Outlet />;
}
