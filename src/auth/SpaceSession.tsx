import { useConvexAuth } from "convex/react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { SpaceSessionAutoSignIn } from "@/components/SpaceSessionAutoSignIn";
import { ViktorAutoSignIn } from "@/components/ViktorAutoSignIn";
import { ViktorMembershipRecheck } from "@/components/ViktorMembershipRecheck";
import { ViktorSignInSection } from "@/components/ViktorSignInSection";
import { getViktorSignInAvailable } from "@/lib/viktor-spaces-access/config";
import { ViktorProductAuthProvider } from "@/lib/viktor-spaces-access/ViktorProductAuthProvider";
import { ViktorOAuthCallbackPage } from "@/pages/ViktorOAuthCallbackPage";
import { Alert } from "@/ui/alert";
import { OAUTH_CALLBACK_PATH } from "./oauthReturn";

/** Shared session lifecycle for authenticated Spaces, independent of app layout. */
export function SpaceSession({ children }: { children: ReactNode }) {
  return (
    <ViktorProductAuthProvider enabled>
      <ViktorAutoSignIn />
      <SpaceSessionAutoSignIn />
      <ViktorMembershipRecheck />
      {children}
    </ViktorProductAuthProvider>
  );
}

/** For single-surface Spaces without application login routes. */
export function SpaceSessionRequired({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { pathname } = useLocation();
  if (pathname === OAUTH_CALLBACK_PATH) return <ViktorOAuthCallbackPage />;
  if (isLoading) return <p role="status">Signing you in...</p>;
  if (isAuthenticated) return <>{children}</>;
  let available = false;
  try {
    available = getViktorSignInAvailable();
  } catch {
    // Invalid configuration stays closed.
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      {available ? (
        <ViktorSignInSection />
      ) : (
        <Alert className="text-destructive">
          Viktor sign-in is unavailable. Contact the Space owner.
        </Alert>
      )}
    </main>
  );
}
