import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  createViktorAuthJsProvider,
  VIKTOR_PUBLIC_CLIENT_SECRET,
  type ViktorAuthJsProfile,
} from "../src/lib/viktor-spaces-access/authjs";
import {
  getViktorSignInAvailable,
  getViktorSpaceAccessMode,
  getViktorSpacesAuthEnabled,
} from "../src/lib/viktor-spaces-access/config";
import type { ViktorSpaceAccessMode } from "../src/lib/viktor-spaces-access/types";

test("shared OAuth return preserves deep links and rejects external destinations", async () => {
  const { readOAuthReturn, clearOAuthReturn } = await import(
    "../src/auth/oauthReturn"
  );
  for (const value of [
    "/dashboard?session=123&mode=display",
    "/reports?year=2026",
  ]) {
    sessionStorage.setItem("viktor-spaces:oauth-return", value);
    expect(readOAuthReturn()).toBe(value);
    expect(readOAuthReturn()).toBe(value); // StrictMode initializer is repeatable.
    clearOAuthReturn();
    expect(readOAuthReturn()).toBe("/dashboard");
  }
  for (const value of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/login",
    "/auth/callback",
    "http://[",
  ]) {
    sessionStorage.setItem("viktor-spaces:oauth-return", value);
    expect(readOAuthReturn()).toBe("/dashboard");
  }
  clearOAuthReturn();
});

test("shared single-surface boundary admits only authenticated sessions", async () => {
  const { SpaceSessionRequired } = await import("../src/auth/SpaceSession");
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/dashboard?session=123&mode=display"]}>
        <SpaceSessionRequired>
          <p>private presentation</p>
        </SpaceSessionRequired>
      </MemoryRouter>,
    );
  convexAuthState = { isAuthenticated: false, isLoading: true };
  expect(render()).not.toContain("private presentation");
  convexAuthState = { isAuthenticated: false, isLoading: false };
  expect(render()).not.toContain("private presentation");
  convexAuthState = { isAuthenticated: true, isLoading: false };
  expect(render()).toContain("private presentation");
});

test("OAuth retry preserves the original display deep link", async () => {
  const { rememberOAuthReturn, readOAuthReturn, clearOAuthReturn } =
    await import("../src/auth/oauthReturn");
  const display = "/dashboard?session=123&mode=display";
  rememberOAuthReturn(display);
  for (const path of [
    "/auth/callback",
    "/auth/callback?error=denied",
    "/login",
    "/signup",
  ]) {
    rememberOAuthReturn(path);
    expect(readOAuthReturn()).toBe(display);
  }
  clearOAuthReturn();
  rememberOAuthReturn("/auth/callback");
  expect(readOAuthReturn()).toBe("/dashboard");
  rememberOAuthReturn("/reports?year=2026");
  expect(readOAuthReturn()).toBe("/reports?year=2026");
  clearOAuthReturn();
});

let convexAuthState = { isAuthenticated: false, isLoading: false };
let convexAuthProviderRenderCount = 0;
const signInMock = mock(async () => ({ signingIn: true }));
const fetchMock = mock();
globalThis.fetch = fetchMock as typeof fetch;
const currentUserQuery = Symbol("currentUser");
const deleteAccountMutation = Symbol("deleteAccount");
const membershipRecheckAction = Symbol("membershipRecheck");
const apiMock = {
  api: {
    auth: {
      currentUser: currentUserQuery,
    },
    users: {
      deleteAccount: deleteAccountMutation,
    },
    viktorMembership: {
      recheck: membershipRecheckAction,
    },
  },
  internal: {
    viktorMembership: {
      viktorAccountsForUser: Symbol("viktorAccountsForUser"),
    },
  },
};

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

mock.module("convex/react", () => ({
  ConvexProviderWithAuth: ({ children }: { children: ReactNode }) => children,
  ConvexReactClient: class {},
  useAction: () => mock(async () => ({ status: "allowed" })),
  useMutation: () => mock(async () => null),
  useConvexAuth: () => convexAuthState,
  useQuery: () => null,
}));

mock.module("@convex-dev/auth/react", () => ({
  ConvexAuthProvider: ({ children }: { children: ReactNode }) => {
    convexAuthProviderRenderCount += 1;
    return children;
  },
  useAuthActions: () => ({
    signIn: signInMock,
    signOut: mock(async () => null),
  }),
}));

mock.module("../convex/_generated/api", () => apiMock);
mock.module("../../convex/_generated/api", () => apiMock);
mock.module("../../../convex/_generated/api", () => apiMock);

beforeEach(() => {
  convexAuthState = { isAuthenticated: false, isLoading: false };
  convexAuthProviderRenderCount = 0;
  signInMock.mockClear();
  fetchMock.mockReset();
  delete process.env.VIKTOR_SPACES_ACCESS_MODE;
  delete process.env.VIKTOR_SPACES_AUTH_PROVIDERS;
  delete process.env.VIKTOR_AUTH_RESOURCE_ID;
  delete process.env.VIKTOR_AUTH_BASE_URL;
  delete process.env.VIKTOR_AUTH_CLIENT_ID;
  delete process.env.VITE_VIKTOR_SPACES_API_URL;
  delete process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS;
  delete process.env.VITE_VIKTOR_SPACES_ENVIRONMENT;
  delete process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS;
  process.env.VITE_VIKTOR_SPACES_ACCESS_MODE = "authenticated";
  process.env.VITE_VIKTOR_SPACES_SPACE_ID = "space_stable_123";
});

function configureAccessMode(mode: ViktorSpaceAccessMode): void {
  process.env.VITE_VIKTOR_SPACES_ACCESS_MODE = mode;
}

async function renderProtectedRoute(
  mode: ViktorSpaceAccessMode,
): Promise<string> {
  configureAccessMode(mode);
  const { ProtectedRoute } = await import("../src/components/ProtectedRoute");
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<div>Dashboard content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

async function renderAppRoute(
  mode: ViktorSpaceAccessMode,
  path: string,
): Promise<string> {
  configureAccessMode(mode);
  if (mode === "authenticated") {
    const { AuthenticatedAppRoutes } = await import(
      "../src/auth/authenticated/AuthenticatedAppRoutes"
    );
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <AuthenticatedAppRoutes />
      </MemoryRouter>,
    );
  }
  const { PublicAppRoutes } = await import(
    "../src/auth/public/PublicAppRoutes"
  );
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <PublicAppRoutes />
    </MemoryRouter>,
  );
}

function viktorProfile(
  overrides: Partial<ViktorAuthJsProfile> = {},
): ViktorAuthJsProfile {
  return {
    sub: "user_1",
    email: "member@example.com",
    name: "Workspace Member",
    resource_type: "space",
    resource_id: "space_123",
    aud: "space:space_123",
    ...overrides,
  };
}

describe("Viktor Spaces auth template contract", () => {
  test("public mode uses a route entrypoint with no auth providers", async () => {
    const html = await renderAppRoute("public", "/");

    expect(html).not.toContain("Sign In");
    expect(html).not.toContain("Get Started");
    expect(convexAuthProviderRenderCount).toBe(0);
  });

  test("missing access mode env fails loudly", () => {
    expect(() =>
      getViktorSpaceAccessMode({
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
      }),
    ).toThrow("Missing required Viktor Spaces env var");
  });

  test("invalid and legacy access modes fail loudly", () => {
    for (const legacyOrInvalid of ["everyone", "space_auth", "viktor_auth"]) {
      expect(() =>
        getViktorSpaceAccessMode({
          VITE_VIKTOR_SPACES_ACCESS_MODE: legacyOrInvalid,
          VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
        }),
      ).toThrow("Invalid VITE_VIKTOR_SPACES_ACCESS_MODE");
    }
  });

  test("access mode env drives the two supported auth strategies", () => {
    expect(
      getViktorSpaceAccessMode({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "public",
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
      }),
    ).toBe("public");
    expect(
      getViktorSpaceAccessMode({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
      }),
    ).toBe("authenticated");
    expect(
      getViktorSpacesAuthEnabled({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
      }),
    ).toBe(true);
    expect(
      getViktorSpacesAuthEnabled({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "public",
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
      }),
    ).toBe(false);
  });

  test("Convex auth provider registration follows access mode", async () => {
    const { configuredProductAuthEnabled } = await import(
      "../convex/viktorSpaceAuthEnv"
    );

    process.env.VIKTOR_SPACES_ACCESS_MODE = "public";
    expect(configuredProductAuthEnabled()).toBe(false);

    process.env.VIKTOR_SPACES_ACCESS_MODE = "authenticated";
    expect(configuredProductAuthEnabled()).toBe(true);
  });

  test("Convex auth provider registration rejects missing and unknown modes", async () => {
    const { configuredProductAuthEnabled } = await import(
      "../convex/viktorSpaceAuthEnv"
    );

    delete process.env.VIKTOR_SPACES_ACCESS_MODE;
    delete process.env.VITE_VIKTOR_SPACES_ACCESS_MODE;
    expect(() => configuredProductAuthEnabled()).toThrow(
      "Missing required Viktor Spaces env var",
    );

    process.env.VIKTOR_SPACES_ACCESS_MODE = "sometimes";
    expect(() => configuredProductAuthEnabled()).toThrow(
      "Invalid VIKTOR_SPACES_ACCESS_MODE",
    );
  });

  test("the Convex Auth JWT lives seven days by default and never past the session", async () => {
    const { DEFAULT_JWT_DURATION_MS, configuredJwtDurationMs } = await import(
      "../convex/viktorSpaceAuthEnv"
    );

    // Pinned: a returning member within the week authenticates with the
    // WebSocket handshake alone instead of a refresh round trip.
    expect(DEFAULT_JWT_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    delete process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS;
    expect(configuredJwtDurationMs()).toBe(DEFAULT_JWT_DURATION_MS);

    // Per-deployment override in milliseconds (e.g. a stricter posture).
    process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS = String(60 * 60 * 1000);
    expect(configuredJwtDurationMs()).toBe(60 * 60 * 1000);

    // Never longer than the 30-day Convex Auth session, never non-positive,
    // never garbage: a misconfigured deploy fails loudly instead of silently
    // minting odd tokens.
    for (const invalid of [
      String(31 * 24 * 60 * 60 * 1000),
      "0",
      "-5",
      "1.5",
      "soon",
    ]) {
      process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS = invalid;
      expect(() => configuredJwtDurationMs()).toThrow(
        "Invalid VIKTOR_SPACES_AUTH_JWT_DURATION_MS",
      );
    }
    delete process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS;
  });

  test("Convex auth tolerates transient legacy env values during a v2 upgrade deploy", async () => {
    const { configuredProductAuthEnabled } = await import(
      "../convex/viktorSpaceAuthEnv"
    );

    // An upgraded space's first v2 deploy analyzes these modules while the
    // Convex deployment still carries the old template's env value; the
    // pipeline syncs it to the v2 mode right after the push. The push must
    // not crash in that window.
    for (const legacyMode of ["space_auth", "viktor_auth"]) {
      process.env.VIKTOR_SPACES_ACCESS_MODE = legacyMode;
      expect(configuredProductAuthEnabled()).toBe(true);
    }
  });

  test("authenticated route primitive preserves Convex auth behavior", async () => {
    convexAuthState = { isAuthenticated: true, isLoading: false };
    const authenticatedHtml = await renderProtectedRoute("authenticated");

    expect(authenticatedHtml).toContain("Dashboard content");

    convexAuthState = { isAuthenticated: false, isLoading: false };
    const unauthenticatedHtml = await renderProtectedRoute("authenticated");

    expect(unauthenticatedHtml).not.toContain("Dashboard content");
  });

  test("authenticated mode owns its Convex Auth provider", async () => {
    const html = await renderAppRoute("authenticated", "/login");

    expect(html).toContain("Sign In");
    expect(convexAuthProviderRenderCount).toBe(1);
  });

  test("the membership re-check is mounted invisibly and only binds Viktor identities", async () => {
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";
    convexAuthState = { isAuthenticated: true, isLoading: false };
    const { getMembershipRecheckAvailability, ViktorMembershipRecheck } =
      await import("../src/components/ViktorMembershipRecheck");

    // Renders nothing: the loop lives in an effect, after first paint.
    expect(renderToStaticMarkup(<ViktorMembershipRecheck />)).toBe("");
    expect(getMembershipRecheckAvailability()).toBe(true);

    // No "Sign in with Viktor" means no Viktor identity to re-check.
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = '["email_password"]';
    expect(getMembershipRecheckAvailability()).toBe(false);
    // An invalid provider list keeps the loop inert instead of throwing.
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = "[]";
    expect(getMembershipRecheckAvailability()).toBe(false);
  });

  test("Viktor plus email/password renders both sign-in paths", async () => {
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS =
      '["email_password","viktor"]';
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";

    const html = await renderAppRoute("authenticated", "/login");

    expect(html).toContain("Sign in with Viktor");
    expect(html).toContain("Sign In");
    expect(html).toContain("Sign up");
    expect(html).toContain("or continue with email");
  });

  test("email/password-only auth renders no Viktor sign-in path", async () => {
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = '["email_password"]';
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";

    const html = await renderAppRoute("authenticated", "/login");

    expect(html).toContain("Sign In");
    expect(html).toContain("Sign up");
    expect(html).not.toContain("Sign in with Viktor");
    expect(html).not.toContain("or continue with email");
  });

  test("Sign in with Viktor is absent without the OAuth client config", async () => {
    delete process.env.VITE_VIKTOR_SPACES_API_URL;

    const html = await renderAppRoute("authenticated", "/login");

    expect(html).not.toContain("Sign in with Viktor");
    expect(html).toContain("Sign In");
  });

  test("viktor-only auth hides email password login and signup flows", async () => {
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = '["viktor"]';

    const loginHtml = await renderAppRoute("authenticated", "/login");
    expect(loginHtml).toContain("Sign in with Viktor");
    expect(loginHtml).not.toContain("Sign In");
    expect(loginHtml).not.toContain("Sign up");
    expect(loginHtml).not.toContain("or continue with email");

    const signupHtml = await renderAppRoute("authenticated", "/signup");
    expect(signupHtml).toContain("Sign in with Viktor");
    expect(signupHtml).not.toContain("Create Account");
    expect(signupHtml).not.toContain("Already have an account?");

    const { LOGIN_FAILED_PATH } = await import("../src/auth/oauthReturn");
    const failedLoginHtml = await renderAppRoute(
      "authenticated",
      LOGIN_FAILED_PATH,
    );
    expect(failedLoginHtml).toContain("Viktor sign-in");
    expect(failedLoginHtml).not.toContain("email and password instead");
  });

  test("a Viktor-only login page explains missing OAuth configuration", async () => {
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = '["viktor"]';
    delete process.env.VITE_VIKTOR_SPACES_API_URL;

    const misconfiguredHtml = await renderAppRoute("authenticated", "/login");
    expect(misconfiguredHtml).toContain("Sign-in is unavailable");

    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";
    const configuredHtml = await renderAppRoute("authenticated", "/login");
    expect(configuredHtml).toContain("Sign in with Viktor");
    expect(configuredHtml).not.toContain("Sign-in is unavailable");
  });

  test("an existing login page explains an invalid empty provider list", async () => {
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = "[]";

    const html = await renderAppRoute("authenticated", "/login");

    expect(html).toContain("Sign-in is unavailable");
    expect(html).toContain("no valid sign-in provider configuration");
    expect(html).not.toContain("Sign in with Viktor");
    expect(html).not.toContain("Sign In");

    const { getAutoSignInAvailability } = await import(
      "../src/components/ViktorAutoSignIn"
    );
    expect(getAutoSignInAvailability()).toBe(false);
  });

  test("OAuth code detection distinguishes successful returns from denials", async () => {
    const { hasOAuthCodeInSearch } = await import("../src/auth/oauthReturn");

    // Successful round trips land with a Convex Auth verification code.
    expect(hasOAuthCodeInSearch("?code=45833532")).toBe(true);
    expect(hasOAuthCodeInSearch("?code=abc&other=1")).toBe(true);
    // Denials land without one.
    expect(hasOAuthCodeInSearch("")).toBe(false);
    expect(hasOAuthCodeInSearch("?error=access_denied")).toBe(false);
  });

  test("auto sign-in intent is detected only for the explicit auto value", async () => {
    const { hasAutoSignInIntentInSearch } = await import(
      "../src/auth/oauthReturn"
    );

    expect(hasAutoSignInIntentInSearch("?viktor_sign_in=auto")).toBe(true);
    // The same param carries the failure signal — never an intent.
    expect(hasAutoSignInIntentInSearch("?viktor_sign_in=failed")).toBe(false);
    expect(hasAutoSignInIntentInSearch("")).toBe(false);
  });

  test("attempt marker peek honors freshness and never consumes", async () => {
    const { hasFreshViktorSignInAttempt, markViktorSignInAttempt } =
      await import("../src/auth/oauthReturn");

    sessionStorage.removeItem("viktor-spaces:viktor-signin-attempt");
    expect(hasFreshViktorSignInAttempt()).toBe(false);

    markViktorSignInAttempt();
    expect(hasFreshViktorSignInAttempt()).toBe(true);
    // Peeking must not consume: the callback route owns consumption.
    expect(hasFreshViktorSignInAttempt()).toBe(true);

    // A stale marker (older than the TTL) no longer blocks an attempt.
    sessionStorage.setItem(
      "viktor-spaces:viktor-signin-attempt",
      String(Date.now() - 6 * 60 * 1000),
    );
    expect(hasFreshViktorSignInAttempt()).toBe(false);

    sessionStorage.setItem("viktor-spaces:viktor-signin-attempt", "not-a-date");
    expect(hasFreshViktorSignInAttempt()).toBe(false);
    sessionStorage.removeItem("viktor-spaces:viktor-signin-attempt");
  });

  test("auto sign-in fires once, only for unauthenticated arrivals with intent", async () => {
    const { resolveAutoSignInAction } = await import(
      "../src/components/ViktorAutoSignIn"
    );
    const base = {
      requestedAutoSignIn: true,
      signInAvailable: true,
      isAuthenticated: false,
      isLoading: false,
      hasRecentAttempt: false,
      hasHandoffToken: false,
    };

    // The intent param plus no session: start the OAuth round trip.
    expect(resolveAutoSignInAction(base)).toBe("start_sign_in");
    // No intent param (every ordinary visit, and every OAuth return leg —
    // the round trip never carries the param back): never auto-fire.
    expect(
      resolveAutoSignInAction({ ...base, requestedAutoSignIn: false }),
    ).toBe("none");
    // Wait for Convex Auth to restore a stored session before deciding.
    expect(resolveAutoSignInAction({ ...base, isLoading: true })).toBe("none");
    // Already signed in: honor the intent by entering the app directly.
    expect(resolveAutoSignInAction({ ...base, isAuthenticated: true })).toBe(
      "enter_app",
    );
    // A recent attempt in flight (back button, reload of the intent URL):
    // never restart — this is the loop breaker.
    expect(resolveAutoSignInAction({ ...base, hasRecentAttempt: true })).toBe(
      "none",
    );
    // Viktor sign-in not configured (or public mode): the param is inert.
    expect(resolveAutoSignInAction({ ...base, signInAvailable: false })).toBe(
      "none",
    );
  });

  test("the edge hand-off token wins over the OAuth round trip for anonymous arrivals", async () => {
    const { resolveAutoSignInAction } = await import(
      "../src/components/ViktorAutoSignIn"
    );
    const base = {
      requestedAutoSignIn: true,
      signInAvailable: true,
      isAuthenticated: false,
      isLoading: false,
      hasRecentAttempt: false,
      hasHandoffToken: true,
    };

    // The gate just verified this member: one in-page exchange, no redirect.
    expect(resolveAutoSignInAction(base)).toBe("exchange_handoff");
    // The attempt marker guards the redirect loop; the exchange never
    // redirects, so a fresh marker does not veto it.
    expect(resolveAutoSignInAction({ ...base, hasRecentAttempt: true })).toBe(
      "exchange_handoff",
    );
    // A stored session still wins: cheaper, and the same user.
    expect(resolveAutoSignInAction({ ...base, isAuthenticated: true })).toBe(
      "enter_app",
    );
    // Never before Convex Auth has tried to restore a stored session.
    expect(resolveAutoSignInAction({ ...base, isLoading: true })).toBe("none");
    // The token is only meaningful when the app has Viktor sign-in at all.
    expect(resolveAutoSignInAction({ ...base, signInAvailable: false })).toBe(
      "none",
    );
    // Without the intent param the token is inert (it never arrives alone).
    expect(
      resolveAutoSignInAction({ ...base, requestedAutoSignIn: false }),
    ).toBe("none");
  });

  test("an in-page sign-in returns to the deep link the visitor opened", async () => {
    const { resolveHandoffDestination } = await import(
      "../src/components/ViktorAutoSignIn"
    );

    // Entry routes go into the app.
    expect(resolveHandoffDestination("/")).toBe("/dashboard");
    expect(resolveHandoffDestination("/login")).toBe("/dashboard");
    expect(resolveHandoffDestination("/signup")).toBe("/dashboard");
    // A deep link (bounced to /login by the route guard while anonymous) is
    // restored, query included.
    expect(resolveHandoffDestination("/reports/42?tab=2")).toBe(
      "/reports/42?tab=2",
    );
    expect(resolveHandoffDestination("/settings")).toBe("/settings");
  });

  test("the landed path drops only the spent intent param", async () => {
    const { stripAutoSignInIntent } = await import("../src/auth/oauthReturn");

    expect(stripAutoSignInIntent("/dashboard", "?viktor_sign_in=auto")).toBe(
      "/dashboard",
    );
    expect(
      stripAutoSignInIntent("/reports/42", "?tab=2&viktor_sign_in=auto"),
    ).toBe("/reports/42?tab=2");
    expect(stripAutoSignInIntent("/", "")).toBe("/");
  });

  test("the intent param is spent before the router mounts", async () => {
    // React Router only listens for popstate, so the strip must run at
    // module evaluation in the entry chunk — AuthStrategyRoutes, not a lazy
    // auth chunk — or useLocation and the embed bridge keep the spent param.
    const shell = await Bun.file(
      new URL("../src/auth/AuthStrategyRoutes.tsx", import.meta.url),
    ).text();
    expect(shell).toContain('import "@/auth/autoSignInIntent";');
    // The re-exports keep the intent API reachable from oauthReturn.
    const intent = await import("../src/auth/autoSignInIntent");
    const oauthReturn = await import("../src/auth/oauthReturn");
    expect(oauthReturn.consumeAutoSignInIntent).toBe(
      intent.consumeAutoSignInIntent,
    );
    expect(oauthReturn.pageLoadRequestedAutoSignIn).toBe(
      intent.pageLoadRequestedAutoSignIn,
    );
  });

  test("the intent param is spent on arrival: read once and removed from the address", async () => {
    const { consumeAutoSignInIntent } = await import(
      "../src/auth/autoSignInIntent"
    );
    const replaced: string[] = [];
    const replaceUrl = (url: string) => {
      replaced.push(url);
    };

    // Present: reported, and the address is rewritten to the same page
    // without it — other params and the fragment survive.
    expect(
      consumeAutoSignInIntent(
        {
          pathname: "/reports/42",
          search: "?tab=2&viktor_sign_in=auto",
          hash: "#row-7",
        },
        replaceUrl,
      ),
    ).toBe(true);
    expect(replaced).toEqual(["/reports/42?tab=2#row-7"]);
    expect(
      consumeAutoSignInIntent(
        { pathname: "/", search: "?viktor_sign_in=auto", hash: "" },
        replaceUrl,
      ),
    ).toBe(true);
    expect(replaced).toEqual(["/reports/42?tab=2#row-7", "/"]);

    // Absent, or the failure value the login page reads: nothing to spend,
    // the address is left alone.
    replaced.length = 0;
    expect(
      consumeAutoSignInIntent(
        { pathname: "/", search: "", hash: "" },
        replaceUrl,
      ),
    ).toBe(false);
    expect(
      consumeAutoSignInIntent(
        { pathname: "/login", search: "?viktor_sign_in=failed", hash: "" },
        replaceUrl,
      ),
    ).toBe(false);
    expect(replaced).toEqual([]);
  });

  test("the hand-off cookie is read strictly and cleared with matching attributes", async () => {
    const {
      SPACE_HANDOFF_COOKIE,
      clearHandoffCookieValue,
      readHandoffTokenFromCookies,
    } = await import("../src/auth/edgeHandoff");

    // Pinned: the edge-gate worker sets exactly this cookie name.
    expect(SPACE_HANDOFF_COOKIE).toBe("__Host-viktor_space_handoff");
    expect(
      readHandoffTokenFromCookies(
        `theme=dark; ${SPACE_HANDOFF_COOKIE}=HANDOFFtoken0123456789; other=1`,
      ),
    ).toBe("HANDOFFtoken0123456789");
    expect(readHandoffTokenFromCookies("theme=dark; other=1")).toBeNull();
    expect(readHandoffTokenFromCookies("")).toBeNull();
    // Only backend-shaped values are ever sent to the exchange.
    expect(
      readHandoffTokenFromCookies(`${SPACE_HANDOFF_COOKIE}=not a token!`),
    ).toBeNull();
    expect(readHandoffTokenFromCookies(`${SPACE_HANDOFF_COOKIE}=`)).toBeNull();
    // A `__Host-` cookie only clears with the attributes it was set with.
    expect(clearHandoffCookieValue()).toBe(
      `${SPACE_HANDOFF_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Lax`,
    );
  });

  test("the hand-off exchange accepts only an allowed edge hand-off for this space", async () => {
    const { EDGE_HANDOFF_CLAIM, acceptedHandoffSession } = await import(
      "../convex/viktorEdgeHandoffAuth"
    );

    // Pinned: the backend stamps exactly this claim (auth/config.py).
    expect(EDGE_HANDOFF_CLAIM).toBe("edge_handoff");
    const allowed = {
      status: "allowed",
      user: {
        id: "user_1",
        email: "member@example.com",
        display_name: "Member",
      },
      resource: {
        resource_type: "space",
        resource_id: "space_123",
        audience: "space:space_123",
        claims: { edge_handoff: true },
      },
    };
    expect(acceptedHandoffSession(allowed, "space_123")).toEqual({
      id: "user_1",
      email: "member@example.com",
      name: "Member",
    });
    // Same profile mapping as the OAuth provider: email stands in for a
    // missing display name, nulls become undefined.
    expect(
      acceptedHandoffSession(
        {
          ...allowed,
          user: {
            id: "user_1",
            email: "member@example.com",
            display_name: null,
          },
        },
        "space_123",
      ),
    ).toEqual({
      id: "user_1",
      email: "member@example.com",
      name: "member@example.com",
    });
    // An automation / screenshot session (no purpose claim) is refused here.
    expect(
      acceptedHandoffSession(
        { ...allowed, resource: { ...allowed.resource, claims: {} } },
        "space_123",
      ),
    ).toBeNull();
    // A token for another space, or a denied check, signs nobody in.
    expect(acceptedHandoffSession(allowed, "space_other")).toBeNull();
    expect(
      acceptedHandoffSession(
        {
          ...allowed,
          resource: {
            ...allowed.resource,
            resource_id: "space_other",
            audience: "space:space_other",
          },
        },
        "space_123",
      ),
    ).toBeNull();
    expect(
      acceptedHandoffSession(
        { status: "denied", reason: "outside_workspace" },
        "space_123",
      ),
    ).toBeNull();
    expect(
      acceptedHandoffSession(
        { ...allowed, status: "unauthenticated" },
        "space_123",
      ),
    ).toBeNull();
  });

  test("a gated arrival sees the signing-in overlay while the stored session is restored", async () => {
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";
    const { ViktorAutoSignIn } = await import(
      "../src/components/ViktorAutoSignIn"
    );

    // Before: the login form (or its skeleton) was visible for the seconds
    // Convex Auth spent restoring the session — the "sign-in page flash".
    convexAuthState = { isAuthenticated: false, isLoading: true };
    const restoringHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login"]}>
        <ViktorAutoSignIn
          requestedAutoSignIn
          handoffToken="tok"
          landedPath="/"
        />
      </MemoryRouter>,
    );
    expect(restoringHtml).toContain("Signing you in...");

    // An ordinary visit (no intent param) is never covered.
    const ordinaryHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login"]}>
        <ViktorAutoSignIn
          requestedAutoSignIn={false}
          handoffToken={null}
          landedPath="/"
        />
      </MemoryRouter>,
    );
    expect(ordinaryHtml).toBe("");
  });

  test("the overlay outlives the hand-off exchange until Convex confirms the session", async () => {
    const { shouldShowSigningInOverlay } = await import(
      "../src/components/ViktorAutoSignIn"
    );
    const gatedArrival = {
      requestedAutoSignIn: true,
      isAuthenticated: false,
      isLoading: false,
      redirecting: false,
      graceExpired: false,
    };

    // The exchange itself is covered.
    expect(
      shouldShowSigningInOverlay({ ...gatedArrival, exchange: "exchanging" }),
    ).toBe(true);
    // `signIn` resolved but `useConvexAuth` has not reported the session yet:
    // still covered. This was the one-frame login-page flash on staging —
    // the route guard rendered an anonymous visitor between the two.
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "awaiting_session",
      }),
    ).toBe(true);
    // Session confirmed: the app takes over.
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "awaiting_session",
        isAuthenticated: true,
      }),
    ).toBe(false);
    // Convex never confirms (backend unreachable): the grace timer lifts the
    // overlay so the page renders whatever it would have rendered anyway.
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "awaiting_session",
        graceExpired: true,
      }),
    ).toBe(false);
    // Nothing in flight and the restore settled: no overlay.
    expect(
      shouldShowSigningInOverlay({ ...gatedArrival, exchange: "idle" }),
    ).toBe(false);
    // The initial restore of a gated arrival is covered; an ordinary visit's
    // restore is not.
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "idle",
        isLoading: true,
      }),
    ).toBe(true);
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "idle",
        isLoading: true,
        requestedAutoSignIn: false,
      }),
    ).toBe(false);
    // The fallback OAuth redirect leaving the page is always covered.
    expect(
      shouldShowSigningInOverlay({
        ...gatedArrival,
        exchange: "idle",
        redirecting: true,
        graceExpired: true,
      }),
    ).toBe(true);
  });

  test("a sign-in completed on /login returns to the protected page that bounced there", async () => {
    const {
      BOUNCED_FROM_STATE_KEY,
      resolveSignedInReturn,
      stripAutoSignInIntent,
    } = await import("../src/auth/oauthReturn");

    // ProtectedRoute records the page it bounces from, minus the spent
    // intent param; PublicOnlyRoute returns a signed-in visitor there. The
    // same derivation as pageLoadLandedPath, so the hand-off's own
    // navigation and this redirect target one path and cannot race.
    const bouncedFrom = stripAutoSignInIntent(
      "/settings",
      "?tab=billing&viktor_sign_in=auto",
    );
    expect(bouncedFrom).toBe("/settings?tab=billing");
    expect(
      resolveSignedInReturn({ [BOUNCED_FROM_STATE_KEY]: bouncedFrom }),
    ).toBe("/settings?tab=billing");
    // No recorded bounce (a direct /login visit): the dashboard.
    expect(resolveSignedInReturn(null)).toBe("/dashboard");
    expect(resolveSignedInReturn({})).toBe("/dashboard");
    // Router state is caller-supplied history: only in-app paths are honored.
    expect(
      resolveSignedInReturn({ [BOUNCED_FROM_STATE_KEY]: "https://evil.test" }),
    ).toBe("/dashboard");
    expect(
      resolveSignedInReturn({ [BOUNCED_FROM_STATE_KEY]: "//evil.test/x" }),
    ).toBe("/dashboard");
    expect(resolveSignedInReturn({ [BOUNCED_FROM_STATE_KEY]: 42 })).toBe(
      "/dashboard",
    );
  });

  test("authenticated enter_app keeps deep links, only entry routes go to the dashboard", async () => {
    const { resolveEnterAppDestination } = await import(
      "../src/components/ViktorAutoSignIn"
    );

    // Entry routes: honoring the intent means moving into the app.
    expect(resolveEnterAppDestination("/")).toBe("/dashboard");
    expect(resolveEnterAppDestination("/login")).toBe("/dashboard");
    expect(resolveEnterAppDestination("/signup")).toBe("/dashboard");
    // Deep links (e.g. the edge gate restoring the visitor's original path
    // with the intent param attached): stay on the page — bouncing to the
    // dashboard would discard the path the visitor asked for.
    expect(resolveEnterAppDestination("/dashboard")).toBe(null);
    expect(resolveEnterAppDestination("/settings")).toBe(null);
    expect(resolveEnterAppDestination("/reports/42")).toBe(null);
  });

  test("OAuth callback routing never fails a sign-in that is still exchanging its code", async () => {
    const { resolveOAuthCallbackDestination } = await import(
      "../src/pages/ViktorOAuthCallbackPage"
    );
    const { LOGIN_FAILED_PATH } = await import("../src/auth/oauthReturn");
    const base = {
      isAuthenticated: false,
      isLoading: false,
      hadOAuthCode: false,
      returnedFromSignIn: false,
      timedOut: false,
    };

    // Landed with a code: stay on the signing-in screen through every
    // transient unauthenticated state (this is the state that used to flash
    // the failure message), even after auth loading settles.
    expect(
      resolveOAuthCallbackDestination({
        ...base,
        hadOAuthCode: true,
        isLoading: true,
      }),
    ).toBeNull();
    expect(
      resolveOAuthCallbackDestination({ ...base, hadOAuthCode: true }),
    ).toBeNull();
    // Exchange finished: straight to the app.
    expect(
      resolveOAuthCallbackDestination({
        ...base,
        hadOAuthCode: true,
        isAuthenticated: true,
      }),
    ).toBe("/dashboard");
    // Exchange stalled past the grace period: explicit failure.
    expect(
      resolveOAuthCallbackDestination({
        ...base,
        hadOAuthCode: true,
        timedOut: true,
      }),
    ).toBe(LOGIN_FAILED_PATH);
    // Denied return (no code, fresh attempt): explicit failure.
    expect(
      resolveOAuthCallbackDestination({ ...base, returnedFromSignIn: true }),
    ).toBe(LOGIN_FAILED_PATH);
    // Stray visit without an attempt: plain login page.
    expect(resolveOAuthCallbackDestination(base)).toBe("/login");
    // Still resolving auth without a code: keep waiting.
    expect(
      resolveOAuthCallbackDestination({ ...base, isLoading: true }),
    ).toBeNull();
  });

  test("OAuth callback route shows a neutral signing-in screen while the code is exchanged", async () => {
    const { ViktorOAuthCallbackPage } = await import(
      "../src/pages/ViktorOAuthCallbackPage"
    );

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <ViktorOAuthCallbackPage hadOAuthCode returnedFromSignIn />
      </MemoryRouter>,
    );

    expect(html).toContain("Signing you in...");
    expect(html).not.toContain("sign in with email and password instead");
  });

  test("login page shows the failure message only with the explicit failure param", async () => {
    process.env.VITE_VIKTOR_SPACES_API_URL = "https://auth.example";
    const { LOGIN_FAILED_PATH } = await import("../src/auth/oauthReturn");

    const failedHtml = await renderAppRoute("authenticated", LOGIN_FAILED_PATH);
    expect(failedHtml).toContain("sign in with email and password instead");

    const plainHtml = await renderAppRoute("authenticated", "/login");
    expect(plainHtml).not.toContain("sign in with email and password instead");
  });

  test("Viktor sign-in availability requires authenticated mode and client config", () => {
    expect(
      getViktorSignInAvailable({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]',
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
        VITE_VIKTOR_SPACES_API_URL: "https://auth.example",
      }),
    ).toBe(true);
    expect(
      getViktorSignInAvailable({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "public",
        VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]',
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
        VITE_VIKTOR_SPACES_API_URL: "https://auth.example",
      }),
    ).toBe(false);
    expect(
      getViktorSignInAvailable({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]',
        VITE_VIKTOR_SPACES_SPACE_ID: "",
        VITE_VIKTOR_SPACES_API_URL: "https://auth.example",
      }),
    ).toBe(false);
    expect(
      getViktorSignInAvailable({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]',
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
        VITE_VIKTOR_SPACES_API_URL: "",
      }),
    ).toBe(false);
    expect(
      getViktorSignInAvailable({
        VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
        VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["email_password"]',
        VITE_VIKTOR_SPACES_SPACE_ID: "space_stable_123",
        VITE_VIKTOR_SPACES_API_URL: "https://auth.example",
      }),
    ).toBe(false);
  });

  test("configured auth providers honor the deployment provider list", async () => {
    const { configuredAuthProviders } = await import(
      "../convex/viktorSpaceAuthConfig"
    );

    process.env.VIKTOR_SPACES_ACCESS_MODE = "authenticated";
    process.env.VIKTOR_SPACES_AUTH_PROVIDERS = '["email_password"]';
    const withoutViktor = configuredAuthProviders();
    expect(
      withoutViktor.some(
        provider => (provider as { id?: string }).id === "viktor",
      ),
    ).toBe(false);
    // Password plus the always-on space_session automation provider. No
    // edge hand-off: it shares the "viktor" accounts, so it only exists
    // alongside the OAuth provider.
    expect(withoutViktor.length).toBe(2);
    expect(
      withoutViktor.some(
        provider => (provider as { id?: string }).id === "space_session",
      ),
    ).toBe(true);
    expect(
      withoutViktor.some(
        provider => (provider as { id?: string }).id === "viktor_edge_handoff",
      ),
    ).toBe(false);

    process.env.VIKTOR_AUTH_RESOURCE_ID = "space_123";
    process.env.VIKTOR_AUTH_BASE_URL = "https://auth.example";
    process.env.VIKTOR_SPACES_AUTH_PROVIDERS = '["viktor"]';
    const viktorOnly = configuredAuthProviders();
    expect(
      viktorOnly.map(provider => (provider as { id?: string }).id),
    ).toEqual(["viktor", "viktor_edge_handoff", "space_session"]);

    process.env.VIKTOR_SPACES_AUTH_PROVIDERS = '["email_password","viktor"]';
    const withViktor = configuredAuthProviders();
    expect(
      withViktor.some(
        provider => (provider as { id?: string }).id === "viktor",
      ),
    ).toBe(true);
    expect(withViktor.length).toBe(4);

    process.env.VIKTOR_SPACES_AUTH_PROVIDERS = "[]";
    expect(() => configuredAuthProviders()).toThrow(
      "Invalid VIKTOR_SPACES_AUTH_PROVIDERS",
    );

    process.env.VIKTOR_SPACES_ACCESS_MODE = "public";
    expect(configuredAuthProviders()).toEqual([]);
  });

  test("Viktor-only provider registration fails closed without OAuth env", async () => {
    const { configuredAuthProviders } = await import(
      "../convex/viktorSpaceAuthConfig"
    );

    process.env.VIKTOR_SPACES_ACCESS_MODE = "authenticated";
    process.env.VIKTOR_SPACES_AUTH_PROVIDERS = '["viktor"]';
    expect(() => configuredAuthProviders()).toThrow(
      "Viktor OAuth deployment env",
    );

    process.env.VIKTOR_AUTH_RESOURCE_ID = "space_123";
    process.env.VIKTOR_AUTH_BASE_URL = "https://auth.example";
    expect(
      configuredAuthProviders().map(
        provider => (provider as { id?: string }).id,
      ),
    ).toEqual(["viktor", "viktor_edge_handoff", "space_session"]);
  });

  test("custom Auth.js provider preserves resource and keeps token exchange server-side", () => {
    const provider = createViktorAuthJsProvider({
      clientId: "space-client",
      resourceId: "space_123",
      viktorAuthBaseUrl: "https://auth.example",
    });

    expect(provider.id).toBe("viktor");
    expect(provider.type).toBe("oauth");
    expect(provider.checks).toEqual(["pkce", "state"]);
    // Public client: PKCE protects the exchange; the placeholder secret only
    // satisfies the OAuth client library, the server ignores it.
    expect(provider.client.token_endpoint_auth_method).toBe(
      "client_secret_post",
    );
    expect(provider.clientSecret).toBe(VIKTOR_PUBLIC_CLIENT_SECRET);
    expect(provider.allowDangerousEmailAccountLinking).toBe(true);
    expect(provider.authorization.url).toBe(
      "https://auth.example/api/viktor-auth/authorize",
    );
    expect(provider.authorization.params.resource).toBe("space:space_123");
    expect(provider.token).toBe(
      "https://auth.example/api/viktor-auth/token?resource=space%3Aspace_123",
    );
    expect(provider.userinfo.url).toBe(
      "https://auth.example/api/viktor-auth/userinfo",
    );
  });

  test("provider profile returns only users-schema fields without Viktor tokens", () => {
    const provider = createViktorAuthJsProvider({
      clientId: "space-client",
      resourceId: "space_123",
      viktorAuthBaseUrl: "https://auth.example",
    });

    const profile = provider.profile(viktorProfile());

    expect(profile).toEqual({
      id: "user_1",
      email: "member@example.com",
      name: "Workspace Member",
    });
    expect(JSON.stringify(profile)).not.toContain("access_token");
    expect(JSON.stringify(profile)).not.toContain("refresh_token");
  });

  test("provider profile strips nulls and falls back to preferred_username", () => {
    const provider = createViktorAuthJsProvider({
      clientId: "space-client",
      resourceId: "space_123",
      viktorAuthBaseUrl: "https://auth.example",
    });

    const profile = provider.profile(
      viktorProfile({
        email: null,
        name: null,
        preferred_username: "member@example.com",
      }),
    );

    expect(profile).toEqual({
      id: "user_1",
      email: undefined,
      name: "member@example.com",
    });
  });

  test("provider profile fails closed on a foreign resource", () => {
    const provider = createViktorAuthJsProvider({
      clientId: "space-client",
      resourceId: "space_123",
      viktorAuthBaseUrl: "https://auth.example",
    });

    expect(() =>
      provider.profile(
        viktorProfile({
          resource_id: "space_other",
          aud: "space:space_other",
        }),
      ),
    ).toThrow("different resource");
    expect(() =>
      provider.profile(viktorProfile({ aud: "space:space_other" })),
    ).toThrow("different resource");
    expect(() =>
      provider.profile(viktorProfile({ resource_type: "edge_target" })),
    ).toThrow("different resource");
  });

  test("provider userinfo loads profile with bearer token and fails closed without one", async () => {
    const provider = createViktorAuthJsProvider({
      clientId: "space-client",
      resourceId: "space_123",
      viktorAuthBaseUrl: "https://auth.example",
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sub: "user_1",
          resource_type: "space",
          resource_id: "space_123",
          aud: "space:space_123",
        }),
        { status: 200 },
      ),
    );

    await expect(
      provider.userinfo.request({ tokens: { access_token: "access-token" } }),
    ).resolves.toEqual({
      sub: "user_1",
      resource_type: "space",
      resource_id: "space_123",
      aud: "space:space_123",
    });
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://auth.example/api/viktor-auth/userinfo",
      { headers: { Authorization: "Bearer access-token" } },
    ]);

    await expect(provider.userinfo.request({ tokens: {} })).rejects.toThrow(
      "requires an access token",
    );
  });

  test("the preview badge renders only on a preview deployment", async () => {
    const {
      PREVIEW_BADGE_DETAILS,
      PREVIEW_BADGE_LABEL,
      PREVIEW_BADGE_WARNING,
      ViktorSpacePreviewBadge,
    } = await import("../src/components/ViktorSpacePreviewBadge");

    // The popover says what a Space is, and the badge carries the warning in
    // its accessible name so a reader gets it without opening the popover.
    expect(PREVIEW_BADGE_DETAILS.join(" ")).toContain("Viktor Space is");
    expect(PREVIEW_BADGE_DETAILS).toContain(PREVIEW_BADGE_WARNING);

    process.env.VITE_VIKTOR_SPACES_ENVIRONMENT = "preview";
    const previewHtml = renderToStaticMarkup(<ViktorSpacePreviewBadge />);
    expect(previewHtml).toContain(PREVIEW_BADGE_LABEL);
    expect(previewHtml).toContain(PREVIEW_BADGE_WARNING);
    expect(previewHtml).toContain("<svg");

    process.env.VITE_VIKTOR_SPACES_ENVIRONMENT = "production";
    expect(renderToStaticMarkup(<ViktorSpacePreviewBadge />)).toBe("");

    // A local `bun run dev` build has no environment at all.
    delete process.env.VITE_VIKTOR_SPACES_ENVIRONMENT;
    expect(renderToStaticMarkup(<ViktorSpacePreviewBadge />)).toBe("");
  });
});
