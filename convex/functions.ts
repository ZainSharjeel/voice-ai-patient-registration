// PHI console redaction (active only on PHI deployments) — imported first
// so any module using these builders gets the shim before handlers run.
import "./phiLogging";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { action, mutation, query } from "./_generated/server";

async function authenticatedContext(ctx: Parameters<typeof getAuthUserId>[0]) {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Not authenticated");
  }
  return { userId };
}

/**
 * Public Convex functions that require a signed-in user.
 *
 * Use these builders for app-facing functions in authenticated Spaces.
 * `ctx.userId` is derived from the verified Convex Auth session.
 */
export const authenticatedQuery = customQuery(
  query,
  customCtx(authenticatedContext),
);

export const authenticatedMutation = customMutation(
  mutation,
  customCtx(authenticatedContext),
);

export const authenticatedAction = customAction(
  action,
  customCtx(authenticatedContext),
);
