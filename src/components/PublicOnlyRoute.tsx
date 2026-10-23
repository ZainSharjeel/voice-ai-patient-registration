import { useConvexAuth } from "convex/react";
import { Navigate, Outlet, useLocation } from "react-router";
import { resolveSignedInReturn } from "@/auth/oauthReturn";
export function PublicOnlyRoute() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const location = useLocation();

  if (isLoading) {
    return <p role="status">Signing you in...</p>;
  }

  if (isAuthenticated) {
    // Back to the protected page ProtectedRoute bounced from, when there is
    // one (a sign-in that completed after the bounce), else the dashboard.
    return <Navigate to={resolveSignedInReturn(location.state)} replace />;
  }

  return <Outlet />;
}
