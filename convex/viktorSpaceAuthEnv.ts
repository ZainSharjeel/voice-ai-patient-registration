declare const process: { env: Record<string, string | undefined> };

// Deployment env values left behind by the pre-v2 template. The deploy
// pipeline pre-syncs VIKTOR_SPACES_ACCESS_MODE to the v2 mode *before*
// `convex deploy`, so a correctly-run upgrade never analyzes these modules
// with a stale legacy value. This set is the belt-and-suspenders fallback:
// if that pre-sync is ever skipped or fails, treat legacy values as "auth
// enabled" so the push doesn't crash. The strict v2 validation below still
// rejects anything genuinely unknown.
const TRANSIENT_LEGACY_ACCESS_MODES = new Set(["space_auth", "viktor_auth"]);

export function configuredProductAuthEnabled(): boolean {
  const configured =
    process.env.VIKTOR_SPACES_ACCESS_MODE ||
    process.env.VITE_VIKTOR_SPACES_ACCESS_MODE;
  if (configured === "authenticated") return true;
  if (configured === "public") return false;
  if (configured && TRANSIENT_LEGACY_ACCESS_MODES.has(configured)) return true;

  if (!configured) {
    throw new Error(
      "Missing required Viktor Spaces env var: VIKTOR_SPACES_ACCESS_MODE",
    );
  }
  throw new Error(`Invalid VIKTOR_SPACES_ACCESS_MODE: ${configured}`);
}

// How long a Convex Auth JWT stays valid before the client has to trade its
// refresh token for a new one. Convex Auth defaults to 1 hour, which made
// almost every return visit pay a WebSocket connect → expired-JWT rejection →
// `auth:signIn` refresh action → re-authenticate sequence (1–3 s on a cold
// Convex deployment) while the app showed its loading state. Seven days lets
// a member who comes back within the week authenticate with the WebSocket
// handshake alone. The cost is revocation latency on the Convex side only:
// a sign-out elsewhere or `invalidateSessions` stops working for an already
// loaded tab once its JWT expires, up to 7 days instead of 1 hour. Who may be
// signed in at all is still decided by Viktor (workspace membership on every
// "Sign in with Viktor" / hand-off, the edge gate on every page load), and the
// Viktor dashboard's own session JWT already lives 14 days. Override per
// deployment with VIKTOR_SPACES_AUTH_JWT_DURATION_MS (milliseconds).
export const DEFAULT_JWT_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
// Never longer than the Convex Auth session itself (30 days by default): a
// JWT that outlives its session would keep a signed-out session usable.
const MAX_JWT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function configuredJwtDurationMs(): number {
  const configured = process.env.VIKTOR_SPACES_AUTH_JWT_DURATION_MS;
  if (!configured) return DEFAULT_JWT_DURATION_MS;
  const parsed = Number(configured);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_JWT_DURATION_MS
  ) {
    throw new Error(
      `Invalid VIKTOR_SPACES_AUTH_JWT_DURATION_MS: ${configured} (expected an integer between 1 and ${MAX_JWT_DURATION_MS} ms)`,
    );
  }
  return parsed;
}
