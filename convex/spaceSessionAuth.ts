import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { DataModel } from "./_generated/dataModel";
import {
  PLATFORM_SESSION_PROVIDER,
  platformSessionEmail,
} from "./platformSession";
import { EDGE_HANDOFF_CLAIM } from "./viktorEdgeHandoffAuth";

// Exchange a backend-minted Viktor space session for a Convex Auth session.
//
// The token comes from `POST /api/viktor-spaces/screenshot-auth-session`, which
// the Viktor backend mints only for a tool-token holder (the agent sandbox and
// the e2e/screenshot runners). It is a short-lived, non-guessable secret. This
// provider does not trust the token on its own: `authorize` sends it back to
// `POST /api/viktor-auth/session`, which validates the hash, the client/resource
// binding, expiry, revocation, and the resource-grant policy before it returns
// the mapped user. An attacker who only has the space URL cannot mint or forge a
// token, so this is NOT an open credentials bypass. It is the automation and
// authenticated-screenshot sign-in path, and it works for every product auth
// provider config because it is a separate exchange, not tied to email_password
// or the Viktor OAuth flow.

declare const process: { env: Record<string, string | undefined> };

interface ViktorAuthSessionResponse {
  status: string;
  reason?: string;
  user?: { id: string; email?: string | null; display_name?: string | null };
  resource?: { claims?: Record<string, unknown> };
}

function spaceResourceId(): string {
  return (
    process.env.VIKTOR_AUTH_RESOURCE_ID ||
    process.env.VITE_VIKTOR_SPACES_SPACE_ID ||
    ""
  );
}

function spaceClientId(): string {
  const resourceId = spaceResourceId();
  return (
    process.env.VIKTOR_AUTH_CLIENT_ID ||
    (resourceId ? `space-${resourceId}` : "")
  );
}

function viktorApiBaseUrl(): string {
  return (
    process.env.VIKTOR_SPACES_API_URL || process.env.VIKTOR_AUTH_BASE_URL || ""
  );
}

const spaceSessionProvider = ConvexCredentials<DataModel>({
  id: PLATFORM_SESSION_PROVIDER,
  authorize: async (params, ctx) => {
    const sessionToken = params.session_token as string | undefined;
    const resourceId = spaceResourceId();
    const clientId = spaceClientId();
    const apiBaseUrl = viktorApiBaseUrl();

    if (!sessionToken) {
      throw new Error("Missing session_token for space session sign-in");
    }
    if (!resourceId || !clientId || !apiBaseUrl) {
      throw new Error(
        "Space session sign-in is not configured on this deployment",
      );
    }

    const response = await fetch(`${apiBaseUrl}/api/viktor-auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_token: sessionToken,
        client_id: clientId,
        resource: `space:${resourceId}`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Space session exchange failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as ViktorAuthSessionResponse;
    if (body.status !== "allowed" || !body.user) {
      throw new Error(
        `Space session not allowed: ${body.reason || body.status}`,
      );
    }
    // Edge-gate hand-off tokens belong to the `viktor_edge_handoff` provider,
    // which signs the real member in; spending one here would mint a phantom
    // automation identity for them instead. Purposes stay exclusive.
    if (body.resource?.claims?.[EDGE_HANDOFF_CLAIM] === true) {
      throw new Error(
        "Space session token is an edge hand-off, not an automation session",
      );
    }

    // A stable, per-Viktor-user account key so repeated sign-ins map to one
    // Convex user instead of creating a new one each time.
    const accountId = `viktor:${body.user.id}`;
    // Do NOT use the Viktor user's real email here. This is an isolated
    // automation identity, kept separate from the owner's own password / Viktor
    // sign-in. If it carried the real verified email, Convex Auth email-linking
    // could merge or split the two accounts (the automation user could inherit
    // the owner's data, or the owner could land on the automation row inserted
    // first). A synthetic, non-routable address keyed to the Viktor user id
    // never collides with a real account.
    const email = platformSessionEmail(body.user.id);
    const name = body.user.display_name || "Space User";

    try {
      const existing = await retrieveAccount(ctx, {
        provider: PLATFORM_SESSION_PROVIDER,
        account: { id: accountId },
      });
      return { userId: existing.user._id };
    } catch {
      // No account yet — create it below.
    }

    const { user } = await createAccount(ctx, {
      provider: PLATFORM_SESSION_PROVIDER,
      account: { id: accountId },
      profile: {
        email,
        name,
        emailVerificationTime: Date.now(),
      },
      shouldLinkViaEmail: false,
    });
    return { userId: user._id };
  },
});

// ConvexCredentials() hard-codes the top-level id to "credentials" and carries
// the configured id in `options`. Convex Auth merges options over the top level
// when it materializes the provider, so the runtime id is "space_session"
// either way. Surface it at the top level too (as the Password provider does)
// so `provider.id` reads as "space_session" wherever it is inspected.
export const SpaceSessionCredentials = {
  ...spaceSessionProvider,
  id: PLATFORM_SESSION_PROVIDER,
};
