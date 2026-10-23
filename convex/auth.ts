// PHI console redaction (active only on PHI deployments) — imported first
// so the auth library's own logging is shimmed too.
import "./phiLogging";
import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import type { HttpRouter } from "convex/server";
import { query } from "./_generated/server";
import { addViktorAuthCallbackRoutes } from "./viktorAuthRedirect";
import { configuredAuthProviders } from "./viktorSpaceAuthConfig";
import { configuredJwtDurationMs } from "./viktorSpaceAuthEnv";

declare const process: { env: Record<string, string | undefined> };

function decodePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.includes("\n")) return key;
  if (key.startsWith("-----BEGIN")) {
    return key
      .replace("-----BEGIN PRIVATE KEY----- ", "-----BEGIN PRIVATE KEY-----\n")
      .replace(" -----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----")
      .split(" ")
      .join("\n");
  }
  try {
    return atob(key);
  } catch {
    return key;
  }
}

const authPrivateKey = process.env.AUTH_PRIVATE_KEY;
if (authPrivateKey) {
  process.env.AUTH_PRIVATE_KEY = decodePrivateKey(authPrivateKey);
}

const jwtPrivateKey = process.env.JWT_PRIVATE_KEY;
if (jwtPrivateKey) {
  process.env.JWT_PRIVATE_KEY = decodePrivateKey(jwtPrivateKey);
}

// Providers are resolved from the space's configured provider list
// (email_password / viktor) plus the `space_session` exchange used by
// automation and authenticated-screenshot capture. See viktorSpaceAuthConfig.ts.
// The JWT lifetime is what decides whether a returning member's stored session
// authenticates with the WebSocket handshake alone or first has to be
// refreshed; see configuredJwtDurationMs.
const configuredAuth = convexAuth({
  providers: configuredAuthProviders(),
  jwt: { durationMs: configuredJwtDurationMs() },
});
export const { signIn, signOut, store, isAuthenticated } = configuredAuth;
export const auth = {
  ...configuredAuth.auth,
  addHttpRoutes(http: HttpRouter) {
    configuredAuth.auth.addHttpRoutes(http);
    addViktorAuthCallbackRoutes(http);
  },
};

export const currentUser = query({
  args: {},
  handler: async ctx => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db.get(userId);
  },
});
