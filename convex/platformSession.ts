// Users the Viktor platform signs in through the `space_session` provider
// (convex/spaceSessionAuth.ts): the e2e test runner, authenticated screenshots
// and the post-deploy thumbnail capture. They are automation, not people, so
// they must never become an admin/owner, claim seed data or start onboarding.
// Runtime-dependency-free so both Convex functions and the frontend can import it.
import type { GenericDatabaseReader } from "convex/server";
import type { DataModel, Id } from "./_generated/dataModel";

export const PLATFORM_SESSION_PROVIDER = "space_session";

const PLATFORM_SESSION_EMAIL_DOMAIN = "@viktor.invalid";

export function platformSessionEmail(viktorUserId: string): string {
  return `space-session-${viktorUserId}${PLATFORM_SESSION_EMAIL_DOMAIN}`;
}

// `.invalid` is a reserved TLD, so no real sign-in can carry this domain.
export function isPlatformSessionEmail(
  email: string | null | undefined,
): boolean {
  return (
    typeof email === "string" &&
    email.trim().toLowerCase().endsWith(PLATFORM_SESSION_EMAIL_DOMAIN)
  );
}

export function isPlatformSessionUser(
  user: { email?: string | null } | null | undefined,
): boolean {
  return isPlatformSessionEmail(user?.email);
}

// The persistent marker is the user's `space_session` account row, which only
// the platform sign-in creates; it holds even if the app later edits the
// user's email. In Convex functions: isPlatformSessionUserId(ctx.db, ctx.userId).
export async function isPlatformSessionUserId(
  db: GenericDatabaseReader<DataModel>,
  userId: Id<"users">,
): Promise<boolean> {
  const account = await db
    .query("authAccounts")
    .withIndex("userIdAndProvider", q =>
      q.eq("userId", userId).eq("provider", PLATFORM_SESSION_PROVIDER),
    )
    .first();
  if (account) return true;
  return isPlatformSessionUser(await db.get(userId));
}
