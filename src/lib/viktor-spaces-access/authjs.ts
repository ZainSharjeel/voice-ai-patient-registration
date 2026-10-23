import {
  AUTHORIZATION_ENDPOINT,
  DEFAULT_SCOPE,
  TOKEN_ENDPOINT,
  USERINFO_ENDPOINT,
} from "./constants";

export type ViktorAuthJsProfile = {
  sub: string;
  email?: string | null;
  name?: string | null;
  preferred_username?: string | null;
  resource_type: string;
  resource_id: string;
  aud: string;
  app_redirect_uri?: string;
};

export type ViktorAppRedirectValidation = {
  requested: () => { siteUrl: string; redirectTo: string } | undefined;
  approved: (redirectTo: string) => void;
};

/**
 * Auth.js-style OAuth provider config consumed by Convex Auth
 * (`convex/viktorSpaceAuthConfig.ts`). "Sign in with Viktor" runs the
 * standard authorization-code + PKCE flow against the Viktor OAuth server;
 * Convex Auth handles the redirects, cookies, code exchange, and account
 * creation. Only members of the workspace that owns this Space can complete
 * the flow — the Viktor server refuses to issue a code to anyone else.
 */
export type ViktorAuthJsProvider = {
  id: "viktor";
  name: "Viktor";
  type: "oauth";
  clientId: string;
  clientSecret: string;
  client: {
    token_endpoint_auth_method: "client_secret_post";
  };
  checks: ["pkce", "state"];
  allowDangerousEmailAccountLinking: true;
  authorization: {
    url: string;
    params: {
      scope: string;
      resource: string;
    };
  };
  token: string;
  userinfo: {
    url: string;
    request: (context: {
      tokens: {
        access_token?: string;
      };
    }) => Promise<ViktorAuthJsProfile>;
  };
  profile: (profile: ViktorAuthJsProfile) => {
    id: string;
    email?: string;
    name?: string;
  };
};

// The Viktor OAuth server treats Spaces as public clients: the code exchange
// is protected by PKCE and the exact-match registered redirect URI, not a
// client secret. Convex Auth's OAuth plumbing requires a non-empty client
// secret to build the token request, so this well-known placeholder is sent
// and ignored server-side.
export const VIKTOR_PUBLIC_CLIENT_SECRET = "viktor-spaces-public-client";

export function createViktorAuthJsProvider(config: {
  clientId: string;
  resourceId: string;
  viktorAuthBaseUrl: string;
  scope?: string;
  appRedirect?: ViktorAppRedirectValidation;
}): ViktorAuthJsProvider {
  const authBaseUrl = config.viktorAuthBaseUrl.replace(/\/$/, "");
  const resource = `space:${config.resourceId}`;
  // The resource travels as a token-endpoint query param because the OAuth
  // client library controls the POST body.
  const tokenUrl = new URL(`${authBaseUrl}${TOKEN_ENDPOINT}`);
  tokenUrl.searchParams.set("resource", resource);
  const userinfoUrl = `${authBaseUrl}${USERINFO_ENDPOINT}`;
  return {
    id: "viktor",
    name: "Viktor",
    type: "oauth",
    clientId: config.clientId,
    clientSecret: VIKTOR_PUBLIC_CLIENT_SECRET,
    client: {
      token_endpoint_auth_method: "client_secret_post",
    },
    checks: ["pkce", "state"],
    // Viktor emails are workspace-verified identities, so linking a Viktor
    // sign-in to an existing password account with the same email is safe
    // and keeps one user row per person.
    allowDangerousEmailAccountLinking: true,
    authorization: {
      url: `${authBaseUrl}${AUTHORIZATION_ENDPOINT}`,
      params: {
        scope: config.scope ?? DEFAULT_SCOPE,
        resource,
      },
    },
    token: tokenUrl.toString(),
    userinfo: {
      url: userinfoUrl,
      request: async ({ tokens }) => {
        const accessToken = tokens.access_token;
        if (!accessToken) {
          throw new Error("Viktor Auth.js provider requires an access token");
        }
        const requested = config.appRedirect?.requested();
        const url = new URL(userinfoUrl);
        if (requested) {
          url.searchParams.set("site_url", requested.siteUrl);
          url.searchParams.set("redirect_to", requested.redirectTo);
        }
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
          ...(requested ? { redirect: "error" as const } : {}),
        });
        if (!response.ok) {
          throw new Error(`Viktor userinfo request failed: ${response.status}`);
        }
        const profile = (await response.json()) as ViktorAuthJsProfile;
        if (requested) {
          if (profile.app_redirect_uri !== requested.redirectTo) {
            throw new Error("Viktor did not approve the Space app redirect");
          }
          config.appRedirect?.approved(profile.app_redirect_uri);
        }
        return profile;
      },
    },
    profile: profile => {
      // Defense-in-depth: a token minted for another resource can never
      // create an account in this app. Throwing fails the sign-in closed.
      if (
        profile.resource_type !== "space" ||
        profile.resource_id !== config.resourceId ||
        profile.aud !== resource
      ) {
        throw new Error(
          "Viktor sign-in returned an identity for a different resource",
        );
      }
      // Only fields present in the Convex Auth `users` table schema —
      // extra fields would fail schema validation on insert.
      return {
        id: profile.sub,
        email: profile.email ?? undefined,
        name: profile.name ?? profile.preferred_username ?? undefined,
      };
    },
  };
}
