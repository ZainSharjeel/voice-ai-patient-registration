import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useConvexAuth } from "convex/react";
import { useEffect, useRef } from "react";
import {
  type Cancel,
  createMembershipRecheckLoop,
  type MembershipRecheckEvent,
  type MembershipRecheckResult,
} from "@/auth/membershipRecheck";
import { getViktorSignInAvailable } from "@/lib/viktor-spaces-access/config";
import { api } from "../../convex/_generated/api";

// Binds the app session to Viktor workspace membership while a tab is open.
//
// Mounted once inside the Convex Auth provider. Renders nothing. While the
// visitor is signed in, runs the membership re-check loop
// (`src/auth/membershipRecheck.ts`): first strictly after first paint, then
// on an interval and whenever the tab becomes visible again. A definitive
// `denied` signs the app out and sends the browser back through the edge
// gate; failures only retry. Inert when "Sign in with Viktor" is not
// configured (no Viktor identity can exist) and while signed out.

/** `requestAnimationFrame` then a macrotask: after the browser has painted. */
function requestAfterFirstPaint(fn: () => void): Cancel {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(fn, 0);
    return () => clearTimeout(timer);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}

function schedule(fn: () => void, delayMs: number): Cancel {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

function onDocumentVisible(fn: () => void): Cancel {
  if (typeof document === "undefined") return () => {};
  const listener = () => {
    if (document.visibilityState === "visible") fn();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function navigateToGatedEntry(path: string): void {
  // A full document navigation, not a router push: the request has to reach
  // the edge gate so it can re-evaluate the visitor.
  window.location.assign(path);
}

// Marks on the performance timeline so the re-check's position relative to
// first paint is inspectable in devtools and by the e2e harness: never on
// the critical path, always after `first-contentful-paint`.
function markPerformance(name: string, detail?: unknown): void {
  if (
    typeof performance === "undefined" ||
    typeof performance.mark !== "function"
  ) {
    return;
  }
  try {
    performance.mark(name, detail === undefined ? undefined : { detail });
  } catch {
    // Older browsers reject the options bag; the mark is best-effort.
  }
}

function recordRecheckEvent(event: MembershipRecheckEvent): void {
  switch (event.type) {
    case "checked":
      markPerformance("viktor-membership-recheck", {
        status: event.result.status,
        elapsedMs: event.elapsedMs,
      });
      return;
    case "check_failed":
      markPerformance("viktor-membership-recheck", {
        status: "error",
        elapsedMs: event.elapsedMs,
      });
      return;
    case "signed_out":
      markPerformance("viktor-membership-bounce", { reason: event.reason });
      return;
    default:
      return;
  }
}

export function getMembershipRecheckAvailability(): boolean {
  try {
    return getViktorSignInAvailable();
  } catch {
    // An invalid provider list is the login page's problem; the loop stays
    // inert rather than binding a session that cannot exist.
    return false;
  }
}

export function ViktorMembershipRecheck() {
  const { isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const recheck = useAction(api.viktorMembership.recheck);
  // The loop's lifetime follows the signed-in state only: a re-render that
  // hands out fresh callback identities must not restart it (and re-run the
  // first check), so the latest callbacks are read through refs.
  const recheckRef = useRef(recheck);
  const signOutRef = useRef(signOut);
  recheckRef.current = recheck;
  signOutRef.current = signOut;

  useEffect(() => {
    if (!isAuthenticated || !getMembershipRecheckAvailability()) return;
    const loop = createMembershipRecheckLoop({
      check: () => recheckRef.current({}) as Promise<MembershipRecheckResult>,
      signOut: () => signOutRef.current(),
      navigate: navigateToGatedEntry,
      requestFirstPaint: requestAfterFirstPaint,
      schedule,
      onVisible: onDocumentVisible,
      now: () => Date.now(),
      onEvent: recordRecheckEvent,
    });
    loop.start();
    return () => loop.stop();
  }, [isAuthenticated]);

  return null;
}
