// Local builds and tests take the Space's access mode from viktor.space.json,
// the file the deploy reads, not from the value .env.local was written with at
// init. vite.config.ts and scripts/auth.ts both import this, so it may import
// only runtime built-ins.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SpaceAccessMode = "public" | "authenticated";

export interface DescriptorAuth {
  mode: SpaceAccessMode;
  providers?: string[];
}

type Env = Record<string, string | undefined>;

const KNOWN_PROVIDERS = new Set(["email_password", "viktor"]);
const DEFAULT_PROVIDERS = ["email_password", "viktor"];

function isProviderList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(provider => KNOWN_PROVIDERS.has(provider))
  );
}

function isProviderListJson(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isProviderList(JSON.parse(value));
  } catch {
    return false;
  }
}

// Legacy (space_auth / viktor_auth), missing and invalid modes give null:
// those builds keep whatever the environment says, as before.
export function parseDescriptorAuth(
  text: string | null | undefined,
): DescriptorAuth | null {
  if (!text?.trim()) return null;
  let auth: unknown;
  try {
    auth = (JSON.parse(text) as { auth?: unknown } | null)?.auth;
  } catch {
    return null;
  }
  if (!auth || typeof auth !== "object") return null;
  const { mode, providers } = auth as { mode?: unknown; providers?: unknown };
  if (mode !== "public" && mode !== "authenticated") return null;
  if (mode === "authenticated" && isProviderList(providers)) {
    return { mode, providers };
  }
  return { mode };
}

export function readDescriptorAuth(projectRoot: string): DescriptorAuth | null {
  try {
    return parseDescriptorAuth(
      readFileSync(join(projectRoot, "viktor.space.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

// Platform deploy builds pass VITE_VIKTOR_SPACES_ENVIRONMENT together with the
// mode they resolved from the same descriptor, so they are left untouched.
export function descriptorBuildEnv(
  descriptor: DescriptorAuth | null,
  env: Env,
): Record<string, string> {
  if (!descriptor || env.VITE_VIKTOR_SPACES_ENVIRONMENT) return {};
  const overrides: Record<string, string> = {
    VITE_VIKTOR_SPACES_ACCESS_MODE: descriptor.mode,
  };
  if (descriptor.mode === "authenticated") {
    const providers =
      descriptor.providers ??
      (isProviderListJson(env.VITE_VIKTOR_SPACES_AUTH_PROVIDERS)
        ? undefined
        : DEFAULT_PROVIDERS);
    if (providers) {
      overrides.VITE_VIKTOR_SPACES_AUTH_PROVIDERS = JSON.stringify(providers);
    }
  }
  return overrides;
}

export function describeOverrides(
  overrides: Record<string, string>,
  env: Env,
): string | null {
  const changed = Object.entries(overrides).filter(
    ([key, value]) => env[key] !== value,
  );
  if (changed.length === 0) return null;
  const parts = changed.map(
    ([key, value]) => `${key}=${value} (was ${env[key] || "unset"})`,
  );
  return `ℹ️  Following viktor.space.json: ${parts.join(", ")}`;
}

const BUILT_ACCESS_MODE_PATH = join("tmp", "built-access-mode.json");

// Vite plugin: records the access mode the bundle was actually built with, so
// the test runner signs in exactly when the served app expects it.
export function builtAccessModePlugin(root: string) {
  let accessMode: unknown;
  return {
    name: "viktor-built-access-mode",
    apply: "build" as const,
    configResolved(config: { env: Record<string, unknown> }) {
      accessMode = config.env.VITE_VIKTOR_SPACES_ACCESS_MODE;
    },
    writeBundle() {
      try {
        mkdirSync(join(root, "tmp"), { recursive: true });
        writeFileSync(
          join(root, BUILT_ACCESS_MODE_PATH),
          `${JSON.stringify({ accessMode: accessMode ?? null })}\n`,
        );
      } catch (error) {
        console.warn(`⚠️  Could not record ${BUILT_ACCESS_MODE_PATH}: ${error}`);
      }
    },
  };
}

// A record older than dist/ came from an earlier build, so it is ignored.
function builtAccessMode(projectRoot: string): string | undefined {
  try {
    const recordPath = join(projectRoot, BUILT_ACCESS_MODE_PATH);
    const builtAt = statSync(join(projectRoot, "dist", "index.html")).mtimeMs;
    if (statSync(recordPath).mtimeMs < builtAt) return undefined;
    const { accessMode } = JSON.parse(readFileSync(recordPath, "utf8"));
    return typeof accessMode === "string" ? accessMode : undefined;
  } catch {
    return undefined;
  }
}

// Without a record (a vite.config.ts that predates the plugin) the bundle took
// the mode from the environment, which Bun loads from .env.local.
export function servedAccessMode(
  projectRoot: string,
  env: Env = process.env,
): string | undefined {
  return builtAccessMode(projectRoot) ?? env.VITE_VIKTOR_SPACES_ACCESS_MODE;
}
