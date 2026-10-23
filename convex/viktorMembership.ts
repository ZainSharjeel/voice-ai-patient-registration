// Membership re-check: is the signed-in member still allowed into this Space?
//
// Convex Auth signs a workspace member in once (edge hand-off or "Sign in
// with Viktor") and then owns the session for up to 30 days; its refresh
// never asks Viktor anything, and the WebSocket the app talks over never
// passes the edge gate. So a member removed from the workspace kept working
// in any open tab, and could reopen the app on a stored session, until the
// session ran out. The client (`src/components/ViktorMembershipRecheck.tsx`)
// calls this action after first paint and on an interval; a `denied` answer
// makes it sign out and return to the gated entry so the edge gate decides.
//
// Server-to-server: the backend is asked with the project secret Convex
// already holds for the tool gateway (the app keeps no Viktor credential
// after sign-in — the hand-off token is single-use and Convex Auth persists
// no OAuth tokens — so `/api/viktor-auth/session` has nothing to validate).
// The backend answers with the same decision every other Space grant uses
// (`SpaceAuthorizationAdapter`): `allowed` or `denied` with a reason.
//
// Only definitive answers can sign anyone out. A backend or network failure
// is reported as `indeterminate` and the client retries; an identity that
// never came from Viktor (an email/password account) is `not_applicable`.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalQuery } from "./_generated/server";
import { authenticatedAction } from "./functions";

declare const process: { env: Record<string, string | undefined> };

// Shared contract with the backend (MEMBERSHIP_CHECK_PATH in
// apis/routers/viktor_spaces_router.py) — keep in sync.
export const MEMBERSHIP_CHECK_PATH = "/api/viktor-spaces/membership-check";
// Convex Auth provider whose account rows carry the Viktor user id (both
// "Sign in with Viktor" and the edge hand-off write them under this id).
const VIKTOR_OAUTH_PROVIDER_ID = "viktor";

export type MembershipRecheckStatus =
  | "allowed"
  | "denied"
  | "not_applicable"
  | "unauthenticated"
  | "indeterminate";

export interface MembershipRecheckResult {
  status: MembershipRecheckStatus;
  reason?: string;
}

interface MembershipCheckResponse {
  status?: string;
  reason?: string | null;
}

/**
 * Pure mapping of the backend's `/membership-check` answer onto the
 * client-facing result: only an explicit `allowed` / `denied` body is
 * definitive; anything else (an HTTP error, an unexpected body) is
 * indeterminate and must never sign anyone out.
 */
export function membershipResultFromResponse(
  httpStatus: number,
  body: MembershipCheckResponse | null,
): MembershipRecheckResult {
  if (httpStatus !== 200 || body === null) {
    return { status: "indeterminate", reason: `http_${httpStatus}` };
  }
  if (body.status === "allowed") return { status: "allowed" };
  if (body.status === "denied") {
    return { status: "denied", reason: body.reason ?? "denied" };
  }
  return { status: "indeterminate", reason: "unexpected_response" };
}

/**
 * One verdict for a user with several Viktor accounts (an installer-split
 * pair shares one email, so email linking can attach both halves to one
 * Convex user): admitted if ANY account is still admitted; denied only when
 * EVERY account is definitively denied; otherwise indeterminate — an
 * unreachable backend for one half must never sign the member out.
 */
export function combineMembershipResults(
  results: MembershipRecheckResult[],
): MembershipRecheckResult {
  if (results.length === 0) return { status: "not_applicable" };
  const allowed = results.find(result => result.status === "allowed");
  if (allowed) return allowed;
  if (results.every(result => result.status === "denied")) return results[0];
  return (
    results.find(result => result.status === "indeterminate") ?? {
      status: "indeterminate",
      reason: "unexpected_response",
    }
  );
}

export const viktorAccountsForUser = internalQuery({
  args: { userId: v.id("users") },
  returns: v.array(v.string()),
  handler: async (ctx, { userId }) => {
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", q =>
        q.eq("userId", userId).eq("provider", VIKTOR_OAUTH_PROVIDER_ID),
      )
      .collect();
    return accounts.map(account => account.providerAccountId);
  },
});

async function checkViktorUser(
  apiUrl: string,
  projectName: string,
  projectSecret: string,
  viktorUserId: string,
): Promise<MembershipRecheckResult> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${MEMBERSHIP_CHECK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_name: projectName,
        project_secret: projectSecret,
        viktor_user_id: viktorUserId,
      }),
    });
  } catch {
    return { status: "indeterminate", reason: "fetch_failed" };
  }
  let body: MembershipCheckResponse | null = null;
  if (response.status === 200) {
    try {
      body = (await response.json()) as MembershipCheckResponse;
    } catch {
      body = null;
    }
  }
  return membershipResultFromResponse(response.status, body);
}

// `authenticatedAction`: a call without a signed-in user throws, which the
// client treats like any other failure (retry, never a sign-out) — the
// `unauthenticated` status is what its loop would resolve that to anyway.
export const recheck = authenticatedAction({
  args: {},
  handler: async (ctx): Promise<MembershipRecheckResult> => {
    const viktorUserIds: string[] = await ctx.runQuery(
      internal.viktorMembership.viktorAccountsForUser,
      { userId: ctx.userId },
    );
    if (viktorUserIds.length === 0) return { status: "not_applicable" };

    const apiUrl = process.env.VIKTOR_SPACES_API_URL;
    const projectName = process.env.VIKTOR_SPACES_PROJECT_NAME;
    const projectSecret = process.env.VIKTOR_SPACES_PROJECT_SECRET;
    if (!apiUrl || !projectName || !projectSecret) {
      return { status: "indeterminate", reason: "not_configured" };
    }
    const results: MembershipRecheckResult[] = [];
    for (const viktorUserId of viktorUserIds) {
      const result = await checkViktorUser(
        apiUrl,
        projectName,
        projectSecret,
        viktorUserId,
      );
      // The first admitted account settles it; only a denial or a failure
      // makes the next account worth asking about.
      if (result.status === "allowed") return result;
      results.push(result);
    }
    return combineMembershipResults(results);
  },
});
