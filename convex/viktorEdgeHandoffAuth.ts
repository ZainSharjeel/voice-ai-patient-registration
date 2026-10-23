import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { DataModel } from "./_generated/dataModel";

// Edge-gate → app sign-in hand-off: "Sign in with Viktor" without the
// second OAuth round trip.
//
// A workspace member who reaches this app through the Viktor edge gate has
// just completed an OAuth round trip with Viktor to prove who they are. The
// gate hands the app a short-lived, single-use Viktor space session token for
// that same member (see `src/auth/edgeHandoff.ts`), and this provider trades
// it for the app's own Convex Auth session with one server-side call —
// instead of sending the browser through `/api/viktor-auth/authorize` again.
//
// The token is not trusted on its own: `authorize` sends it back to
// `POST /api/viktor-auth/session`, which validates the hash, the
// client/resource binding, expiry, revocation and the workspace-membership
// grant — the same check the OAuth authorize step makes — and then revokes it
// (single use). The provider additionally insists the session carries the
// `edge_handoff` purpose claim, so an automation/screenshot token can never
// be spent here and vice versa.
//
// The account it signs into is the SAME account "Sign in with Viktor" would
// create or find (provider `viktor`, account id = the Viktor user id, email
// linked to an existing password account), so a member who sometimes arrives
// through the gate and sometimes clicks the button is one user, not two.

declare const process: { env: Record<string, string | undefined> };

export const VIKTOR_EDGE_HANDOFF_PROVIDER_ID = "viktor_edge_handoff";
// Purpose claim the Viktor backend stamps on hand-off sessions
// (SPACE_HANDOFF_CLAIM in auth/config.py) — keep in sync.
export const EDGE_HANDOFF_CLAIM = "edge_handoff";
// Convex Auth provider whose account rows this hand-off shares.
const VIKTOR_OAUTH_PROVIDER_ID = "viktor";

interface ViktorAuthSessionResponse {
  status: string;
  reason?: string;
  user?: { id: string; email?: string | null; display_name?: string | null };
  resource?: {
    resource_type: string;
    resource_id: string;
    audience: string;
    claims?: Record<string, unknown>;
  };
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

/**
 * Pure acceptance check for a `/session` response: only an allowed session
 * for THIS space that was minted as an edge hand-off signs anyone in.
 */
export function acceptedHandoffSession(
  body: ViktorAuthSessionResponse,
  resourceId: string,
): { id: string; email?: string; name?: string } | null {
  if (body.status !== "allowed" || !body.user || !body.resource) return null;
  if (
    body.resource.resource_type !== "space" ||
    body.resource.resource_id !== resourceId ||
    body.resource.audience !== `space:${resourceId}`
  ) {
    return null;
  }
  if (body.resource.claims?.[EDGE_HANDOFF_CLAIM] !== true) return null;
  return {
    id: body.user.id,
    email: body.user.email ?? undefined,
    // Mirrors the OAuth provider's profile mapping (name, else the email as
    // preferred_username) so both paths write the same user fields.
    name: body.user.display_name ?? body.user.email ?? undefined,
  };
}

const viktorEdgeHandoffProvider = ConvexCredentials<DataModel>({
  id: VIKTOR_EDGE_HANDOFF_PROVIDER_ID,
  authorize: async (params, ctx) => {
    const sessionToken = params.session_token as string | undefined;
    const resourceId = spaceResourceId();
    const clientId = spaceClientId();
    const apiBaseUrl = viktorApiBaseUrl();

    if (!sessionToken) {
      throw new Error("Missing session_token for Viktor edge hand-off sign-in");
    }
    if (!resourceId || !clientId || !apiBaseUrl) {
      throw new Error(
        "Viktor edge hand-off sign-in is not configured on this deployment",
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
      throw new Error(
        `Viktor edge hand-off exchange failed: HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as ViktorAuthSessionResponse;
    const profile = acceptedHandoffSession(body, resourceId);
    if (profile === null) {
      throw new Error(
        `Viktor edge hand-off not accepted: ${body.reason || body.status}`,
      );
    }

    // Same account key as the OAuth provider (providerAccountId = Viktor user
    // id under provider "viktor"), so the two sign-in paths converge on one
    // Convex user.
    try {
      const existing = await retrieveAccount<DataModel>(ctx, {
        provider: VIKTOR_OAUTH_PROVIDER_ID,
        account: { id: profile.id },
      });
      return { userId: existing.user._id };
    } catch {
      // No Viktor account yet — create it below, exactly as a first OAuth
      // sign-in would.
    }

    // Viktor emails are workspace-verified identities: the "viktor" OAuth
    // provider sets allowDangerousEmailAccountLinking, which Convex Auth reads
    // off the provider here too, so this links to an existing password
    // account with the same email exactly as a first OAuth sign-in would.
    const { user } = await createAccount<DataModel>(ctx, {
      provider: VIKTOR_OAUTH_PROVIDER_ID,
      account: { id: profile.id },
      profile: {
        email: profile.email,
        name: profile.name,
        emailVerificationTime: Date.now(),
      },
      shouldLinkViaEmail: true,
    });
    return { userId: user._id };
  },
});

// ConvexCredentials() hard-codes the top-level id to "credentials" and carries
// the configured id in `options`; surface it at the top level too (as
// spaceSessionAuth.ts does) so `provider.id` reads correctly when inspected.
export const ViktorEdgeHandoffCredentials = {
  ...viktorEdgeHandoffProvider,
  id: VIKTOR_EDGE_HANDOFF_PROVIDER_ID,
};
