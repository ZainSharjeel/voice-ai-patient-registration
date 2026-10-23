import { ConvexProvider } from "convex/react";
import { Navigate, Outlet, Route, Routes } from "react-router";
import { convex } from "@/auth/convexClient";
import { PublicHeader } from "@/components/PublicHeader";
import { PublicLandingPage } from "@/pages/PublicLandingPage";

function PublicShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader />
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
    </div>
  );
}

export function PublicAppRoutes() {
  return (
    <ConvexProvider client={convex}>
      <Routes>
        <Route element={<PublicShell />}>
          <Route path="/" element={<PublicLandingPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConvexProvider>
  );
}
