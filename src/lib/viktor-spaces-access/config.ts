import type { ViktorSpaceAccessMode } from "./types";

const VALID_ACCESS_MODES = new Set(["public", "authenticated"]);
const DEFAULT_AUTH_PROVIDER_NAMES = ["email_password", "viktor"] as const;
type AuthProviderName = (typeof DEFAULT_AUTH_PROVIDER_NAMES)[number];

type ViktorSpacesEnv = Pick<
  ImportMetaEnv,
  | "VITE_VIKTOR_AUTH_CLIENT_ID"
  | "VITE_VIKTOR_SPACES_ACCESS_MODE"
  | "VITE_VIKTOR_SPACES_API_URL"
  | "VITE_VIKTOR_SPACES_AUTH_PROVIDERS"
  | "VITE_VIKTOR_SPACES_ENVIRONMENT"
  | "VITE_VIKTOR_SPACES_SPACE_ID"
>;

function getDefaultViktorSpacesEnv(): ViktorSpacesEnv {
  const viteEnv = import.meta.env as ViktorSpacesEnv | undefined;
  if (viteEnv) {
    return viteEnv;
  }
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return (runtime.process?.env ?? {}) as ViktorSpacesEnv;
}

function requireEnvValue(
  env: ViktorSpacesEnv,
  name: keyof ViktorSpacesEnv,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required Viktor Spaces env var: ${name}`);
  }
  return value;
}

export function getViktorSpaceAccessMode(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): ViktorSpaceAccessMode {
  const configured = requireEnvValue(env, "VITE_VIKTOR_SPACES_ACCESS_MODE");
  if (!VALID_ACCESS_MODES.has(configured)) {
    throw new Error(`Invalid VITE_VIKTOR_SPACES_ACCESS_MODE: ${configured}`);
  }
  return configured as ViktorSpaceAccessMode;
}

export function getViktorSpacesAuthEnabled(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): boolean {
  return getViktorSpaceAccessMode(env) === "authenticated";
}

function getViktorSpacesAuthProviderNames(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): Set<AuthProviderName> {
  const configured = env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS;
  if (!configured) {
    return new Set(DEFAULT_AUTH_PROVIDER_NAMES);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error(`Invalid VITE_VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Invalid VITE_VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`);
  }

  const providerNames = new Set<AuthProviderName>();
  for (const provider of parsed) {
    if (provider !== "email_password" && provider !== "viktor") {
      throw new Error(
        `Invalid VITE_VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`,
      );
    }
    if (providerNames.has(provider)) {
      throw new Error(
        `Invalid VITE_VIKTOR_SPACES_AUTH_PROVIDERS: ${configured}`,
      );
    }
    providerNames.add(provider);
  }
  return providerNames;
}

export function getViktorSpacesSpaceId(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): string {
  return env.VITE_VIKTOR_SPACES_SPACE_ID || "";
}

export function getViktorAuthBaseUrl(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): string {
  return env.VITE_VIKTOR_SPACES_API_URL || "";
}

export function getViktorAuthClientId(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): string {
  const configured = env.VITE_VIKTOR_AUTH_CLIENT_ID;
  if (configured) return configured;
  const spaceId = getViktorSpacesSpaceId(env);
  return spaceId ? `space-${spaceId}` : "";
}

/**
 * Whether "Sign in with Viktor" is available: the app is `authenticated`
 * and the Viktor OAuth client config was injected at build time.
 */
export function getViktorSignInAvailable(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): boolean {
  return (
    getViktorSpacesAuthEnabled(env) &&
    getViktorSpacesAuthProviderNames(env).has("viktor") &&
    Boolean(getViktorSpacesSpaceId(env)) &&
    Boolean(getViktorAuthBaseUrl(env))
  );
}

export function getEmailPasswordSignInAvailable(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): boolean {
  return (
    getViktorSpacesAuthEnabled(env) &&
    getViktorSpacesAuthProviderNames(env).has("email_password")
  );
}

/**
 * Whether this bundle was built for the Space's preview deployment.
 *
 * Viktor passes `VITE_VIKTOR_SPACES_ENVIRONMENT` in the deploy build command
 * (`preview` or `production`). A local `bun run dev` / `bun run build` has
 * neither, and is not a preview.
 */
export function getViktorSpaceIsPreviewDeployment(
  env: ViktorSpacesEnv = getDefaultViktorSpacesEnv(),
): boolean {
  return env.VITE_VIKTOR_SPACES_ENVIRONMENT === "preview";
}
