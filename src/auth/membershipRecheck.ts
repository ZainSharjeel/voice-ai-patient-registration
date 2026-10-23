// Membership re-check loop: keeps the app session bound to Viktor membership.
//
// Convex Auth owns the app session for up to 30 days and its refresh never
// re-checks Viktor workspace membership, so a member removed from the
// workspace kept working in an open tab (and on any stored session) for
// the rest of that window. This loop asks the backend — through the
// `viktorMembership:recheck` Convex action — whether the signed-in identity
// is still an admitted member, and on a definitive `denied` signs the app
// out and returns the browser to the gated entry so the edge gate decides.
//
// Timing rules, all off the critical path:
// - The first check runs strictly after first paint (`requestFirstPaint`
//   is `requestAnimationFrame` + a macrotask in the browser); nothing here
//   ever delays the page.
// - Then every `MEMBERSHIP_RECHECK_INTERVAL_MS` while the tab is open, and
//   again when a hidden tab becomes visible (debounced by
//   `MEMBERSHIP_RECHECK_MIN_GAP_MS`), so a tab someone comes back to is
//   re-checked at once instead of at its next tick.
// - A network/backend failure (`indeterminate`, or the action throwing) is
//   retried with backoff and NEVER signs anyone out. Only `denied` does.
// - `not_applicable` (an identity that never came from Viktor, e.g. an
//   email/password account) stops the loop: there is nothing to bind.
//
// The loop is a plain object with injected dependencies so the whole
// behaviour is unit-testable without a DOM; the React component
// (`components/ViktorMembershipRecheck.tsx`) only wires it to the browser.

export const MEMBERSHIP_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
// A tab that becomes visible again is re-checked at once unless it was
// checked this recently (rapid tab switching must not hammer the backend).
export const MEMBERSHIP_RECHECK_MIN_GAP_MS = 30 * 1000;
// Backoff after an indeterminate answer: first retry, doubling up to the
// regular interval.
export const MEMBERSHIP_RECHECK_RETRY_MS = 30 * 1000;
// Where a bounced member is sent: the app's entry route, a full document
// navigation through the edge gate so the gate re-evaluates the visitor.
export const GATED_ENTRY_PATH = "/";

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

export type MembershipRecheckAction = "keep" | "sign_out" | "stop" | "retry";

/**
 * Pure decision for one answer. `denied` is the only thing that ever signs
 * anyone out; failures retry; an identity Viktor does not know stops.
 */
export function resolveMembershipRecheckAction(
  outcome: MembershipRecheckResult | Error,
): MembershipRecheckAction {
  if (outcome instanceof Error) return "retry";
  switch (outcome.status) {
    case "allowed":
      return "keep";
    case "denied":
      return "sign_out";
    case "not_applicable":
      return "stop";
    // Convex says there is no session while the client still thinks there
    // is one (a token that expired mid-flight, a sign-out racing us): the
    // app's own auth state settles this; re-ask later rather than act.
    case "unauthenticated":
    case "indeterminate":
      return "retry";
  }
}

/** Retry delay after `failures` consecutive indeterminate answers. */
export function membershipRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 10));
  return Math.min(
    MEMBERSHIP_RECHECK_RETRY_MS * 2 ** exponent,
    MEMBERSHIP_RECHECK_INTERVAL_MS,
  );
}

/**
 * Whether a tab that just became visible should be re-checked now: only if
 * the last check is older than the minimum gap (or none has run yet).
 */
export function shouldRecheckOnVisible(
  lastCheckedAt: number | null,
  now: number,
): boolean {
  return (
    lastCheckedAt === null ||
    now - lastCheckedAt >= MEMBERSHIP_RECHECK_MIN_GAP_MS
  );
}

export type Cancel = () => void;

export interface MembershipRecheckDeps {
  /** The `viktorMembership:recheck` action. May reject on transport failure. */
  check: () => Promise<MembershipRecheckResult>;
  /** Convex Auth `signOut`. May reject; then the denial is retried. */
  signOut: () => Promise<void>;
  /** Full document navigation to the gated entry. */
  navigate: (path: string) => void;
  /** Run `fn` strictly after the next paint; returns a cancel. */
  requestFirstPaint: (fn: () => void) => Cancel;
  /** `setTimeout` shape; returns a cancel. */
  schedule: (fn: () => void, delayMs: number) => Cancel;
  /** Subscribe to "the tab became visible"; returns an unsubscribe. */
  onVisible: (fn: () => void) => Cancel;
  now: () => number;
  /** Observability hook (a denial, an error); never affects behaviour. */
  onEvent?: (event: MembershipRecheckEvent) => void;
}

export type MembershipRecheckEvent =
  | { type: "checked"; result: MembershipRecheckResult; elapsedMs: number }
  | { type: "check_failed"; error: unknown; elapsedMs: number }
  | { type: "signed_out"; reason: string | undefined }
  | { type: "sign_out_failed"; error: unknown }
  | { type: "stopped" };

export interface MembershipRecheckLoop {
  /** Arm the loop: the first check runs after the next paint. Idempotent. */
  start(): void;
  /** Cancel every pending timer and subscription. Idempotent. */
  stop(): void;
  /** Force a check now (tests, visibility). No-op while one is in flight. */
  runNow(): Promise<void>;
  readonly checksStarted: number;
  readonly lastCheckedAt: number | null;
}

export function createMembershipRecheckLoop(
  deps: MembershipRecheckDeps,
): MembershipRecheckLoop {
  let started = false;
  let stopped = false;
  let inFlight = false;
  let failures = 0;
  let checksStarted = 0;
  let lastCheckedAt: number | null = null;
  let cancelPending: Cancel | null = null;
  let unsubscribeVisible: Cancel | null = null;

  const emit = (event: MembershipRecheckEvent) => {
    try {
      deps.onEvent?.(event);
    } catch {
      // Observability must never break the loop.
    }
  };

  const clearPending = () => {
    if (cancelPending !== null) {
      cancelPending();
      cancelPending = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    clearPending();
    cancelPending = deps.schedule(() => {
      cancelPending = null;
      void runCheck();
    }, delayMs);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearPending();
    if (unsubscribeVisible !== null) {
      unsubscribeVisible();
      unsubscribeVisible = null;
    }
    emit({ type: "stopped" });
  };

  const runCheck = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    checksStarted += 1;
    const startedAt = deps.now();
    let outcome: MembershipRecheckResult | Error;
    try {
      outcome = await deps.check();
      emit({
        type: "checked",
        result: outcome,
        elapsedMs: deps.now() - startedAt,
      });
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
      emit({ type: "check_failed", error, elapsedMs: deps.now() - startedAt });
    }
    inFlight = false;
    lastCheckedAt = deps.now();
    if (stopped) return;
    switch (resolveMembershipRecheckAction(outcome)) {
      case "keep":
        failures = 0;
        scheduleNext(MEMBERSHIP_RECHECK_INTERVAL_MS);
        return;
      case "retry":
        failures += 1;
        scheduleNext(membershipRetryDelayMs(failures));
        return;
      case "stop":
        stop();
        return;
      case "sign_out": {
        const reason = outcome instanceof Error ? undefined : outcome.reason;
        try {
          await deps.signOut();
        } catch (error) {
          // The sign-out itself failed (Convex unreachable). Navigating now
          // would reload the app onto the still-stored session, which would
          // deny again and reload again; retry the denial instead.
          emit({ type: "sign_out_failed", error });
          failures += 1;
          scheduleNext(membershipRetryDelayMs(failures));
          return;
        }
        emit({ type: "signed_out", reason });
        stop();
        deps.navigate(GATED_ENTRY_PATH);
        return;
      }
    }
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribeVisible = deps.onVisible(() => {
        if (stopped || inFlight) return;
        if (!shouldRecheckOnVisible(lastCheckedAt, deps.now())) return;
        clearPending();
        void runCheck();
      });
      // Strictly after first paint: the loop must never delay the page.
      cancelPending = deps.requestFirstPaint(() => {
        cancelPending = null;
        void runCheck();
      });
    },
    stop,
    runNow: () => runCheck(),
    get checksStarted() {
      return checksStarted;
    },
    get lastCheckedAt() {
      return lastCheckedAt;
    },
  };
}
