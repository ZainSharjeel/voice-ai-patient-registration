import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { httpRouter, queryGeneric } from "convex/server";

mock.module("../convex/_generated/server", () => ({ query: queryGeneric }));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const site = "https://one.viktor.space";
const custom = "https://app.example.com/auth/callback";
const convexSite = "https://one.convex.site";
const requests: URL[] = [];
let userinfo: (url: URL) => Response | Promise<Response>;

function profile(redirectTo?: string) {
  return {
    sub: "member",
    email: "member@example.com",
    name: "Member",
    aud: "space:one",
    resource_type: "space",
    resource_id: "one",
    ...(redirectTo ? { app_redirect_uri: redirectTo } : {}),
  };
}

beforeEach(() => {
  process.env.SITE_URL = site;
  process.env.VIKTOR_AUTH_RESOURCE_ID = "one";
  process.env.VIKTOR_AUTH_CLIENT_ID = "space-one";
  process.env.VIKTOR_AUTH_BASE_URL = "https://api.test";
  process.env.CONVEX_SITE_URL = convexSite;
  process.env.VIKTOR_SPACES_ACCESS_MODE = "authenticated";
  process.env.VIKTOR_SPACES_AUTH_PROVIDERS = '["viktor"]';
  requests.length = 0;
  userinfo = url =>
    Response.json(profile(url.searchParams.get("redirect_to") ?? undefined));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    if (url.pathname === "/api/viktor-auth/token") {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("code")).toBe("provider-code");
      expect(body.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
      expect(body.get("redirect_uri")).toBe(
        `${convexSite}/api/auth/callback/viktor`,
      );
      expect(url.searchParams.get("resource")).toBe("space:one");
      return Response.json({
        access_token: "test-access-token",
        token_type: "bearer",
        expires_in: 300,
      });
    }
    if (url.pathname === "/api/viktor-auth/userinfo") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer test-access-token",
      );
      return userinfo(url);
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

async function start(redirectTo: string) {
  const { auth } = await import("../convex/auth");
  const http = httpRouter();
  auth.addHttpRoutes(http);
  let signature: string | undefined;
  const createdAccounts: string[] = [];
  const ctx = {
    runMutation: mock(
      async (ref: unknown, { args }: { args: Record<string, string> }) => {
        expect(ref).toBe("auth:store");
        if (args.type === "verifierSignature") {
          signature = args.signature;
          return;
        }
        if (args.type === "userOAuth") {
          expect(args.signature).toBe(signature);
          createdAccounts.push(args.providerAccountId);
          return "test-app-code";
        }
        throw new Error(`Unexpected auth mutation: ${args.type}`);
      },
    ),
  };
  const [signin] = http.lookup("/api/auth/signin/viktor", "GET")!;
  const url = new URL(`${convexSite}/api/auth/signin/viktor`);
  url.searchParams.set("code", "browser-verifier");
  url.searchParams.set("redirectTo", redirectTo);
  const response = await signin._handler(ctx, new Request(url));
  expect(response.status).toBe(302);
  const authorization = new URL(response.headers.get("Location")!);
  const cookie = response.headers
    .getSetCookie()
    .map(value => value.split(";")[0])
    .join("; ");

  return {
    createdAccounts,
    authorization,
    async finish({
      error,
      state,
      method = "GET",
    }: {
      error?: string;
      state?: string;
      method?: "GET" | "POST";
    } = {}) {
      const params = new URLSearchParams({
        state: state ?? authorization.searchParams.get("state")!,
        ...(error ? { error } : { code: "provider-code" }),
      });
      const callbackUrl = new URL(`${convexSite}/api/auth/callback/viktor`);
      if (method === "GET") callbackUrl.search = params.toString();
      const request = new Request(callbackUrl, {
        method,
        headers: {
          Cookie: cookie,
          ...(method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(method === "POST" ? { body: params.toString() } : {}),
      });
      const [callback] = http.lookup(callbackUrl.pathname, method)!;
      return callback._handler(ctx, request);
    },
  };
}

describe("Space OAuth browser returns without an extra network request", () => {
  test("spaces without OAuth do not mount the callback override", async () => {
    const { convexAuth } = await import("@convex-dev/auth/server");
    const { addViktorAuthCallbackRoutes } = await import(
      "../convex/viktorAuthRedirect"
    );
    const stockAuth = convexAuth({ providers: [] }).auth;
    const http = httpRouter();
    stockAuth.addHttpRoutes(http);
    addViktorAuthCallbackRoutes(http);
    expect(http.lookup("/api/auth/callback/viktor", "GET")).toBeNull();
  });

  test.each([
    "GET",
    "POST",
  ] as const)("stock Convex %s callback releases its code only to the userinfo-approved hostname", async method => {
    const flow = await start(custom);
    const response = await flow.finish({ method });
    expect(response.headers.get("Location")).toBe(
      `${custom}?code=test-app-code`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(flow.createdAccounts).toEqual(["member"]);
    expect(requests.map(url => url.pathname)).toEqual([
      "/api/viktor-auth/token",
      "/api/viktor-auth/userinfo",
    ]);
    expect(requests[1].searchParams.get("site_url")).toBe(site);
    expect(requests[1].searchParams.get("redirect_to")).toBe(custom);
  });

  test("canonical login keeps the existing two requests without redirect parameters", async () => {
    const flow = await start(`${site}/auth/callback`);
    const response = await flow.finish();
    expect(response.headers.get("Location")).toBe(
      `${site}/auth/callback?code=test-app-code`,
    );
    expect(response.headers.get("Cache-Control")).toBe("must-revalidate");
    expect(requests).toHaveLength(2);
    expect(requests[1].search).toBe("");
  });

  test.each([
    "missing",
    "different",
    "revoked",
    "network",
  ] as const)("fails closed when userinfo approval is %s", async failure => {
    const flow = await start(custom);
    userinfo = () => {
      if (failure === "network") throw new Error("userinfo unavailable");
      if (failure === "revoked") return new Response(null, { status: 400 });
      return Response.json(
        profile(
          failure === "different"
            ? "https://other.example.com/auth/callback"
            : undefined,
        ),
      );
    };
    const response = await flow.finish();
    expect(response.headers.get("Location")).toBe(
      `${site}/login?viktor_sign_in=failed`,
    );
    expect(flow.createdAccounts).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  test.each([
    "denial",
    "bad-state",
  ] as const)("a %s cannot redirect to an unapproved custom hostname", async failure => {
    const flow = await start(custom);
    const response = await flow.finish(
      failure === "denial"
        ? { error: "access_denied" }
        : { state: "wrong-state" },
    );
    expect(response.headers.get("Location")).toBe(
      `${site}/login?viktor_sign_in=failed`,
    );
    expect(flow.createdAccounts).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("concurrent callbacks cannot borrow another request's approval", async () => {
    const other = "https://unapproved.example.com/auth/callback";
    const first = await start(custom);
    const second = await start(other);
    let unblockFirst: () => void = () => {};
    const waiting = new Promise<void>(resolve => {
      unblockFirst = resolve;
    });
    userinfo = async url => {
      if (url.searchParams.get("redirect_to") === custom) {
        await waiting;
        return Response.json(profile(custom));
      }
      unblockFirst();
      return Response.json(profile());
    };
    const [approved, rejected] = await Promise.all([
      first.finish(),
      second.finish(),
    ]);
    expect(approved.headers.get("Location")).toBe(
      `${custom}?code=test-app-code`,
    );
    expect(rejected.headers.get("Location")).toBe(
      `${site}/login?viktor_sign_in=failed`,
    );
    expect(first.createdAccounts).toEqual(["member"]);
    expect(second.createdAccounts).toEqual([]);
  });

  test.each([
    "//evil.test/auth/callback",
    "https://app.example.com:443/auth/callback",
    "https://user@app.example.com/auth/callback",
    "http://app.example.com/auth/callback",
    `${custom}?next=https://evil.test`,
    `${custom}#fragment`,
    `${custom}\n`,
    "https://app.example.com/auth/%63allback",
    "https://app.example.com/x/../auth/callback",
    "https://app.example.com\\@evil.test/auth/callback",
    "javascript:alert(1)",
  ])("rejects malformed destinations before OAuth exchange: %s", async redirectTo => {
    const flow = await start(redirectTo);
    await expect(flow.finish()).rejects.toThrow("Invalid auth redirect");
    expect(requests).toHaveLength(0);
  });
});
