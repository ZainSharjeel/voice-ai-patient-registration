import { lazy, Suspense } from "react";
// Side effect on purpose, and it must stay in this entry-chunk module: the
// auto sign-in intent param is read and stripped from the address bar at
// module evaluation, before the router mounts. Every other auth module is
// behind a lazy route chunk, where a strip would come too late for
// `useLocation` and the embed bridge below (see autoSignInIntent.ts).
import "@/auth/autoSignInIntent";
import { ViktorEmbedBridge } from "@/components/ViktorEmbedBridge";
import {
  useViktorSpaceAccess,
  ViktorSpaceAccessProvider,
} from "@/lib/viktor-spaces-access/ViktorSpaceAccessProvider";

const PublicAppRoutes = lazy(() =>
  import("./public/PublicAppRoutes").then(module => ({
    default: module.PublicAppRoutes,
  })),
);
const AuthenticatedAppRoutes = lazy(() =>
  import("./authenticated/AuthenticatedAppRoutes").then(module => ({
    default: module.AuthenticatedAppRoutes,
  })),
);

function AuthStrategyLoading() {
  return null;
}

export function AuthStrategyRoutes() {
  return (
    <ViktorSpaceAccessProvider>
      {/* Inside the router, outside the app's own routes: the dashboard's
          embed bridge must report the very first route, whichever it is. */}
      <ViktorEmbedBridge />
      <AuthStrategyRoutesInner />
    </ViktorSpaceAccessProvider>
  );
}

function AuthStrategyRoutesInner() {
  const { authEnabled } = useViktorSpaceAccess();

  const routes = authEnabled ? <AuthenticatedAppRoutes /> : <PublicAppRoutes />;

  return <Suspense fallback={<AuthStrategyLoading />}>{routes}</Suspense>;
}
