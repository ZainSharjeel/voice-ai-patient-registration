import { useConvexAuth } from "convex/react";
import { Link } from "react-router";
import { controlStyles } from "@/components/controlStyles";
import { APP_NAME } from "@/lib/constants";
import { getEmailPasswordSignInAvailable } from "@/lib/viktor-spaces-access/config";

export { LoginPage } from "./LoginPage";
export { SettingsPage } from "./SettingsPage";
export { SignupPage } from "./SignupPage";

// Unstyled starting points: they work end to end and carry no design.

/** `/`: signed-out visitors and members who lost access land here. */
export function LandingPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-4">
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
      {!isLoading && (
        <div className="flex flex-wrap gap-2">
          <Link
            to={isAuthenticated ? "/dashboard" : "/login"}
            className={controlStyles.primaryButton}
          >
            {isAuthenticated ? "Open app" : "Sign in"}
          </Link>
          {!isAuthenticated && getEmailPasswordSignInAvailable() && (
            <Link to="/signup" className={controlStyles.outlineButton}>
              Create an account
            </Link>
          )}
        </div>
      )}
    </main>
  );
}

/** `/dashboard`: the signed-in home. */
export function DashboardPage() {
  return (
    <main className="p-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
    </main>
  );
}
