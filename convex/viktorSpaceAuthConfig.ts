import { Password } from "@convex-dev/auth/providers/Password";
import type { AuthProviderConfig } from "@convex-dev/auth/server";
import {
  createViktorAuthJsProvider,
  type ViktorAppRedirectValidation,
} from "../src/lib/viktor-spaces-access/authjs";
import { SpaceSessionCredentials } from "./spaceSessionAuth";
import {
  ViktorSpacesEmail,
  ViktorSpacesPasswordReset,
} from "./ViktorSpacesEmail";
import { ViktorEdgeHandoffCredentials } from "./viktorEdgeHandoffAuth";
import { configuredProductAuthEnabled } from "./viktorSpaceAuthEnv";

declare const process: { env: Record<string, string | undefined> };

const DEFAULT_AUTH_PROVIDER_NAMES = ["email_password", "viktor"] as const;
type AuthProviderName = (typeof DEFAULT_AUTH_PROVIDER_NAMES)[number];

function configuredAuthProviderNames(): Set<AuthProviderName> {
  const configured =
    process.env.VIKTOR_SPACES_AUTH_PROVIDERS ||
    process.env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS;
  if (!configured) {
    return new Set(DEFAULT_AUTH_PROVIDER_NAMES);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error(`Invalid VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Invalid VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
  }

  const providerNames = new Set<AuthProviderName>();
  for (const provider of parsed) {
    if (provider !== "email_password" && provider !== "viktor") {
      throw new Error(`Invalid VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
    }
    if (providerNames.has(provider)) {
      throw new Error(`Invalid VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
    }
    providerNames.add(provider);
  }
  return providerNames;
}

function viktorWorkspaceSignInProviders(
  appRedirect?: ViktorAppRedirectValidation,
): AuthProviderConfig[] {
  const resourceId = process.env.VIKTOR_AUTH_RESOURCE_ID || "";
  const viktorAuthBaseUrl = process.env.VIKTOR_AUTH_BASE_URL || "";
  if (!resourceId || !viktorAuthBaseUrl) {
    // Deployments without a Viktor control plane (local dev) still get
    // email + password auth; "Sign in with Viktor" is simply absent.
    return [];
  }
  return [
    // Hand-rolled Auth.js-style OAuth config; structurally compatible with
    // the provider shape Convex Auth consumes.
    createViktorAuthJsProvider({
      clientId: process.env.VIKTOR_AUTH_CLIENT_ID || `space-${resourceId}`,
      resourceId,
      viktorAuthBaseUrl,
      appRedirect,
    }) as unknown as AuthProviderConfig,
    // Edge-gate hand-off into the same "viktor" accounts: members arriving
    // through the gate are signed in with one server-side exchange instead
    // of a second OAuth round trip. Registered only alongside the OAuth
    // provider, whose account rows it shares.
    ViktorEdgeHandoffCredentials,
  ];
}

function configuredSpaceAuthProviders(
  appRedirect?: ViktorAppRedirectValidation,
): AuthProviderConfig[] {
  const providerNames = configuredAuthProviderNames();
  const providers: AuthProviderConfig[] = [];
  if (providerNames.has("email_password")) {
    providers.push(
      Password({
        verify: ViktorSpacesEmail,
        reset: ViktorSpacesPasswordReset,
      }),
    );
  }
  if (providerNames.has("viktor")) {
    const viktorProviders = viktorWorkspaceSignInProviders(appRedirect);
    if (viktorProviders.length === 0 && !providerNames.has("email_password")) {
      throw new Error(
        "Viktor sign-in is the only configured provider but the Viktor OAuth " +
          "deployment env (VIKTOR_AUTH_RESOURCE_ID, VIKTOR_AUTH_BASE_URL) is " +
          "missing. Configure it or include email_password in auth.providers.",
      );
    }
    providers.push(...viktorProviders);
  }
  // Automation and authenticated-screenshot sign-in. Safe on every deployment:
  // it only accepts a backend-minted, server-validated space session token, so
  // it is not a human-reachable credentials bypass. Replaces the preview-only
  // TestCredentials provider.
  providers.push(SpaceSessionCredentials);
  return providers;
}

export function configuredAuthProviders(
  appRedirect?: ViktorAppRedirectValidation,
): AuthProviderConfig[] {
  return configuredProductAuthEnabled()
    ? configuredSpaceAuthProviders(appRedirect)
    : [];
}
