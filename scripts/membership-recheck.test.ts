import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type Cancel,
  createMembershipRecheckLoop,
  GATED_ENTRY_PATH,
  MEMBERSHIP_RECHECK_INTERVAL_MS,
  MEMBERSHIP_RECHECK_MIN_GAP_MS,
  MEMBERSHIP_RECHECK_RETRY_MS,
  type MembershipRecheckDeps,
  type MembershipRecheckEvent,
  type MembershipRecheckResult,
  membershipRetryDelayMs,
  resolveMembershipRecheckAction,
  shouldRecheckOnVisible,
} from "../src/auth/membershipRecheck";

// The Convex module imports the generated api/server bindings, which exist
// only after `convex codegen`; stand them in.
mock.module("../convex/_generated/api", () => ({
  api: {},
  internal: { viktorMembership: { viktorAccountsForUser: "internal-ref" } },
}));
mock.module("../convex/_generated/server", () => ({
  action: (definition: unknown) => definition,
  mutation: (definition: unknown) => definition,
  query: (definition: unknown) => definition,
  internalQuery: (definition: unknown) => definition,
}));

/**
 * A deterministic browser for the loop: manual clock, manual timers, manual
 * paint and visibility. Nothing runs unless the test says so.
 */
class FakeBrowser {
  time = 0;
  paintCallbacks: Array<() => void> = [];
  timers: Array<{ id: number; at: number; fn: () => void }> = [];
  visibleListeners: Array<() => void> = [];
  navigations: string[] = [];
  events: MembershipRecheckEvent[] = [];
  private nextTimer = 1;

  deps(overrides: Partial<MembershipRecheckDeps>): MembershipRecheckDeps {
    return {
      check: async () => ({ status: "allowed" }),
      signOut: async () => {},
      navigate: path => {
        this.navigations.push(path);
      },
      requestFirstPaint: (fn): Cancel => {
        this.paintCallbacks.push(fn);
        return () => {
          this.paintCallbacks = this.paintCallbacks.filter(cb => cb !== fn);
        };
      },
      schedule: (fn, delayMs): Cancel => {
        const id = this.nextTimer++;
        this.timers.push({ id, at: this.time + delayMs, fn });
        return () => {
          this.timers = this.timers.filter(timer => timer.id !== id);
        };
      },
      onVisible: (fn): Cancel => {
        this.visibleListeners.push(fn);
        return () => {
          this.visibleListeners = this.visibleListeners.filter(
            listener => listener !== fn,
          );
        };
      },
      now: () => this.time,
      onEvent: event => {
        this.events.push(event);
      },
      ...overrides,
    };
  }

  /** The browser paints; the loop's first check may now start. */
  paint(): void {
    const callbacks = this.paintCallbacks;
    this.paintCallbacks = [];
    for (const callback of callbacks) callback();
  }

  /** Delays of every pending timer, relative to now. */
  pendingDelays(): number[] {
    return this.timers.map(timer => timer.at - this.time).sort((a, b) => a - b);
  }

  /** Advance the clock and fire every timer that came due. */
  advance(ms: number): void {
    this.time += ms;
    const due = this.timers
      .filter(timer => timer.at <= this.time)
      .sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter(timer => timer.at > this.time);
    for (const timer of due) timer.fn();
  }

  becomeVisible(): void {
    for (const listener of this.visibleListeners) listener();
  }
}

// Let every awaited step inside the loop (check, signOut) settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let browser: FakeBrowser;

beforeEach(() => {
  browser = new FakeBrowser();
});

describe("membership re-check decisions", () => {
  test("only a definitive denial signs out; failures retry; unknown identities stop", () => {
    expect(resolveMembershipRecheckAction({ status: "allowed" })).toBe("keep");
    expect(
      resolveMembershipRecheckAction({
        status: "denied",
        reason: "outside_workspace",
      }),
    ).toBe("sign_out");
    expect(resolveMembershipRecheckAction({ status: "not_applicable" })).toBe(
      "stop",
    );
    expect(resolveMembershipRecheckAction({ status: "unauthenticated" })).toBe(
      "retry",
    );
    expect(
      resolveMembershipRecheckAction({
        status: "indeterminate",
        reason: "http_502",
      }),
    ).toBe("retry");
    expect(resolveMembershipRecheckAction(new Error("network down"))).toBe(
      "retry",
    );
  });

  test("retry backoff doubles from the retry delay and caps at the interval", () => {
    expect(membershipRetryDelayMs(1)).toBe(MEMBERSHIP_RECHECK_RETRY_MS);
    expect(membershipRetryDelayMs(2)).toBe(2 * MEMBERSHIP_RECHECK_RETRY_MS);
    expect(membershipRetryDelayMs(3)).toBe(4 * MEMBERSHIP_RECHECK_RETRY_MS);
    expect(membershipRetryDelayMs(20)).toBe(MEMBERSHIP_RECHECK_INTERVAL_MS);
    // Pinned: the product numbers reviewers agreed on.
    expect(MEMBERSHIP_RECHECK_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(MEMBERSHIP_RECHECK_MIN_GAP_MS).toBe(30 * 1000);
    expect(MEMBERSHIP_RECHECK_RETRY_MS).toBe(30 * 1000);
    expect(GATED_ENTRY_PATH).toBe("/");
  });

  test("a tab becoming visible re-checks unless it was checked moments ago", () => {
    expect(shouldRecheckOnVisible(null, 1_000_000)).toBe(true);
    expect(shouldRecheckOnVisible(1_000_000, 1_000_000 + 1_000)).toBe(false);
    expect(
      shouldRecheckOnVisible(
        1_000_000,
        1_000_000 + MEMBERSHIP_RECHECK_MIN_GAP_MS,
      ),
    ).toBe(true);
  });
});

describe("membership re-check loop", () => {
  test("the first check runs strictly after first paint, never on start", async () => {
    const check = mock(
      async (): Promise<MembershipRecheckResult> => ({ status: "allowed" }),
    );
    const loop = createMembershipRecheckLoop(browser.deps({ check }));

    loop.start();
    await settle();
    // Armed, but nothing has been asked: the page has not painted yet.
    expect(check).toHaveBeenCalledTimes(0);
    expect(loop.checksStarted).toBe(0);
    expect(browser.paintCallbacks).toHaveLength(1);
    expect(browser.pendingDelays()).toEqual([]);

    browser.paint();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(loop.lastCheckedAt).toBe(0);
    // Allowed: the next check is one interval away.
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_INTERVAL_MS]);
    expect(browser.navigations).toEqual([]);

    browser.advance(MEMBERSHIP_RECHECK_INTERVAL_MS);
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    loop.stop();
    expect(browser.pendingDelays()).toEqual([]);
  });

  test("a denial signs out of Convex Auth, then navigates to the gated entry", async () => {
    const signOut = mock(async () => {});
    const order: string[] = [];
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => ({ status: "denied", reason: "outside_workspace" }),
        signOut: async () => {
          order.push("sign_out");
          await signOut();
        },
        navigate: path => {
          order.push(`navigate:${path}`);
          browser.navigations.push(path);
        },
      }),
    );

    loop.start();
    browser.paint();
    await settle();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(browser.navigations).toEqual([GATED_ENTRY_PATH]);
    // Sign-out completes before the document navigation starts.
    expect(order).toEqual(["sign_out", `navigate:${GATED_ENTRY_PATH}`]);
    // The loop is over: no timers, no visibility listener left behind.
    expect(browser.pendingDelays()).toEqual([]);
    expect(browser.visibleListeners).toEqual([]);
    expect(browser.events).toContainEqual({
      type: "signed_out",
      reason: "outside_workspace",
    });
    expect(loop.checksStarted).toBe(1);
  });

  test("a network error never signs out; it retries with backoff", async () => {
    const signOut = mock(async () => {});
    let attempts = 0;
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => {
          attempts += 1;
          throw new Error("Failed to fetch");
        },
        signOut,
      }),
    );

    loop.start();
    browser.paint();
    await settle();
    expect(attempts).toBe(1);
    expect(signOut).toHaveBeenCalledTimes(0);
    expect(browser.navigations).toEqual([]);
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_RETRY_MS]);

    browser.advance(MEMBERSHIP_RECHECK_RETRY_MS);
    await settle();
    expect(attempts).toBe(2);
    expect(browser.pendingDelays()).toEqual([2 * MEMBERSHIP_RECHECK_RETRY_MS]);
    expect(signOut).toHaveBeenCalledTimes(0);
    expect(browser.navigations).toEqual([]);
    loop.stop();
  });

  test("an indeterminate backend answer is treated exactly like a network error", async () => {
    const signOut = mock(async () => {});
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => ({ status: "indeterminate", reason: "http_503" }),
        signOut,
      }),
    );

    loop.start();
    browser.paint();
    await settle();
    expect(signOut).toHaveBeenCalledTimes(0);
    expect(browser.navigations).toEqual([]);
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_RETRY_MS]);
    loop.stop();
  });

  test("a recovered backend resets the backoff to the regular interval", async () => {
    const answers: MembershipRecheckResult[] = [
      { status: "indeterminate", reason: "http_502" },
      { status: "allowed" },
    ];
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => answers.shift() ?? { status: "allowed" },
      }),
    );

    loop.start();
    browser.paint();
    await settle();
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_RETRY_MS]);
    browser.advance(MEMBERSHIP_RECHECK_RETRY_MS);
    await settle();
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_INTERVAL_MS]);
    loop.stop();
  });

  test("a failed sign-out does not reload the app onto the stored session; it retries", async () => {
    let signOutAttempts = 0;
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => ({ status: "denied", reason: "disabled_user" }),
        signOut: async () => {
          signOutAttempts += 1;
          if (signOutAttempts === 1) throw new Error("Convex unreachable");
        },
      }),
    );

    loop.start();
    browser.paint();
    await settle();
    expect(signOutAttempts).toBe(1);
    // No navigation on a failed sign-out (it would loop: reload, deny, reload).
    expect(browser.navigations).toEqual([]);
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_RETRY_MS]);

    browser.advance(MEMBERSHIP_RECHECK_RETRY_MS);
    await settle();
    expect(signOutAttempts).toBe(2);
    expect(browser.navigations).toEqual([GATED_ENTRY_PATH]);
  });

  test("an identity Viktor does not know stops the loop without signing out", async () => {
    const signOut = mock(async () => {});
    const loop = createMembershipRecheckLoop(
      browser.deps({
        check: async () => ({ status: "not_applicable" }),
        signOut,
      }),
    );

    loop.start();
    browser.paint();
    await settle();
    expect(signOut).toHaveBeenCalledTimes(0);
    expect(browser.navigations).toEqual([]);
    expect(browser.pendingDelays()).toEqual([]);
    expect(browser.visibleListeners).toEqual([]);
    expect(browser.events.at(-1)).toEqual({ type: "stopped" });
  });

  test("a tab that becomes visible is re-checked at once, debounced by the minimum gap", async () => {
    const check = mock(
      async (): Promise<MembershipRecheckResult> => ({ status: "allowed" }),
    );
    const loop = createMembershipRecheckLoop(browser.deps({ check }));

    loop.start();
    browser.paint();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);

    // Switching tabs right back: too soon, nothing happens.
    browser.advance(1_000);
    browser.becomeVisible();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);

    // Coming back after the gap: checked now, and the interval restarts.
    browser.advance(MEMBERSHIP_RECHECK_MIN_GAP_MS);
    browser.becomeVisible();
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    expect(browser.pendingDelays()).toEqual([MEMBERSHIP_RECHECK_INTERVAL_MS]);
    loop.stop();
  });

  test("stopping before the first paint cancels the check entirely", async () => {
    const check = mock(
      async (): Promise<MembershipRecheckResult> => ({ status: "allowed" }),
    );
    const loop = createMembershipRecheckLoop(browser.deps({ check }));

    loop.start();
    loop.stop();
    browser.paint();
    await settle();
    expect(check).toHaveBeenCalledTimes(0);
    expect(browser.paintCallbacks).toEqual([]);
    expect(browser.visibleListeners).toEqual([]);
  });
});

describe("membership re-check Convex action contract", () => {
  test("the backend path is pinned and only an explicit answer is definitive", async () => {
    const { MEMBERSHIP_CHECK_PATH, membershipResultFromResponse } =
      await import("../convex/viktorMembership");

    // Pinned: MEMBERSHIP_CHECK_PATH in apis/routers/viktor_spaces_router.py.
    expect(MEMBERSHIP_CHECK_PATH).toBe("/api/viktor-spaces/membership-check");
    expect(membershipResultFromResponse(200, { status: "allowed" })).toEqual({
      status: "allowed",
    });
    expect(
      membershipResultFromResponse(200, {
        status: "denied",
        reason: "outside_workspace",
      }),
    ).toEqual({ status: "denied", reason: "outside_workspace" });
    expect(
      membershipResultFromResponse(200, { status: "denied", reason: null }),
    ).toEqual({ status: "denied", reason: "denied" });
    // A misconfigured secret, an outage, a garbled body: never a denial.
    expect(membershipResultFromResponse(403, null)).toEqual({
      status: "indeterminate",
      reason: "http_403",
    });
    expect(membershipResultFromResponse(502, null)).toEqual({
      status: "indeterminate",
      reason: "http_502",
    });
    expect(membershipResultFromResponse(200, null)).toEqual({
      status: "indeterminate",
      reason: "http_200",
    });
    expect(membershipResultFromResponse(200, { status: "maybe" })).toEqual({
      status: "indeterminate",
      reason: "unexpected_response",
    });
  });

  test("a user with several Viktor accounts is denied only when every account is", async () => {
    const { combineMembershipResults } = await import(
      "../convex/viktorMembership"
    );
    const denied = { status: "denied" as const, reason: "outside_workspace" };
    const allowed = { status: "allowed" as const };
    const failed = { status: "indeterminate" as const, reason: "http_502" };

    // No Viktor account at all: nothing to bind.
    expect(combineMembershipResults([])).toEqual({ status: "not_applicable" });
    // An installer-split pair: one half still admitted keeps the session.
    expect(combineMembershipResults([denied, allowed])).toEqual(allowed);
    // Both halves gone: definitive.
    expect(combineMembershipResults([denied, denied])).toEqual(denied);
    // A backend failure for one half can never be read as a denial.
    expect(combineMembershipResults([denied, failed])).toEqual(failed);
    expect(combineMembershipResults([failed])).toEqual(failed);
  });
});
