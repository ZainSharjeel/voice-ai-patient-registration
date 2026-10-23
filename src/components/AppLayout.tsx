import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { Link, Outlet } from "react-router";
import { controlStyles } from "@/components/controlStyles";
import { APP_NAME } from "@/lib/constants";
import { api } from "../../convex/_generated/api";

/**
 * Signed-in shell, unstyled. Replace this bar with the app's own navigation
 * and keep Settings and Sign out reachable from every signed-in screen.
 */
export function AppLayout() {
  const user = useQuery(api.auth.currentUser);
  const { signOut } = useAuthActions();

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b p-4">
        <Link to="/dashboard" className="mr-auto font-semibold">
          {APP_NAME}
        </Link>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {user?.email}
        </span>
        <Link to="/settings" className={controlStyles.quietButton}>
          Settings
        </Link>
        <button
          type="button"
          className={controlStyles.quietButton}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </header>
      <Outlet />
    </>
  );
}
