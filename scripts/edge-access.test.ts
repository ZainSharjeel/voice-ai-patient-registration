import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { EdgeAccess, edgeAccessHeaders, PageHelper } from "./auth";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const requests: { url: string; init?: RequestInit }[] = [];
let reply: () => Response;

beforeEach(() => {
  process.env.VIKTOR_SPACES_API_URL = "https://api.test";
  process.env.VIKTOR_SPACES_PROJECT_NAME = "demo";
  process.env.VIKTOR_SPACES_PROJECT_SECRET = "project-secret";
  process.env.VIKTOR_AUTH_RESOURCE_ID = "space_demo";
  process.env.TOOL_TOKEN = "tool-token";
  requests.length = 0;
  reply = () =>
    Response.json({
      success: true,
      header_name: "x-viktor-edge-access",
      token: "edge-token",
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  setSystemTime();
});

type RouteHandler = (route: unknown) => Promise<void>;

function fakeContext() {
  const handlers: RouteHandler[] = [];
  const context = {
    route: async (_match: unknown, handler: RouteHandler) => {
      handlers.push(handler);
    },
  } as unknown as BrowserContext;
  // What the browser sends for one request through the installed route.
  const send = async (url: string): Promise<Record<string, string>> => {
    let sent: Record<string, string> = {};
    await handlers[0]({
      request: () => ({
        url: () => url,
        headers: () => ({ accept: "text/html" }),
      }),
      continue: async (overrides: { headers: Record<string, string> }) => {
        sent = overrides.headers;
      },
    });
    return sent;
  };
  return { context, handlers, send };
}

function mintsReturning(...tokens: (string | number)[]) {
  reply = () => {
    const next = tokens.shift();
    return typeof next === "number"
      ? new Response("busy", { status: next })
      : Response.json({
          success: true,
          header_name: "x-viktor-edge-access",
          token: next,
          expires_in_seconds: 600,
        });
  };
}

test("a failed mint is not kept: the next attach mints again", async () => {
  const { context, handlers, send } = fakeContext();
  const access = new EdgeAccess(context);
  mintsReturning(503, "t1");

  await expect(access.attach("https://demo.viktor.space/")).rejects.toThrow(
    "HTTP 503",
  );
  expect(handlers).toHaveLength(0);
  await access.attach("https://demo.viktor.space/");

  expect(requests).toHaveLength(2);
  expect(handlers).toHaveLength(1);
  expect(
    (await send("https://demo.viktor.space/app.js"))["x-viktor-edge-access"],
  ).toBe("t1");
});

test("a token is re-minted a minute before it expires, once for concurrent requests", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  setSystemTime(start);
  const { context, handlers, send } = fakeContext();
  const access = new EdgeAccess(context);
  mintsReturning("t1", "t2");
  await access.attach("https://demo.viktor.space/");
  await access.attach("https://demo.viktor.space/reports");

  setSystemTime(new Date(start.getTime() + 530_000));
  expect(
    (await send("https://demo.viktor.space/"))["x-viktor-edge-access"],
  ).toBe("t1");
  expect(requests).toHaveLength(1);

  setSystemTime(new Date(start.getTime() + 545_000));
  const sent = await Promise.all([
    send("https://demo.viktor.space/"),
    send("https://demo.viktor.space/app.js"),
  ]);
  expect(sent.map(headers => headers["x-viktor-edge-access"])).toEqual([
    "t2",
    "t2",
  ]);
  expect(sent[0].accept).toBe("text/html");
  expect(requests).toHaveLength(2);
  expect(handlers).toHaveLength(1);
});

test("a re-mint that fails mid-page sends the request without a stale token", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  setSystemTime(start);
  const { context, send } = fakeContext();
  const access = new EdgeAccess(context);
  mintsReturning("t1", 503, "t3");
  await access.attach("https://demo.viktor.space/");

  setSystemTime(new Date(start.getTime() + 590_000));
  expect(await send("https://demo.viktor.space/")).toEqual({
    accept: "text/html",
  });
  expect(
    (await send("https://demo.viktor.space/"))["x-viktor-edge-access"],
  ).toBe("t3");
});

test("goto re-mints once when the worker answers 401 to the header", async () => {
  const { context, send } = fakeContext();
  const statuses = [401, 401];
  const visited: string[] = [];
  const page = {
    on: () => {},
    goto: async (url: string) => {
      visited.push(url);
      const status = statuses.shift() ?? 200;
      return { status: () => status };
    },
  } as unknown as Page;
  const helper = new PageHelper(page, {} as Browser, context);
  mintsReturning("t1", "t2", "t3");

  await helper.goto("https://demo.viktor.space/reports");

  expect(visited).toEqual([
    "https://demo.viktor.space/reports",
    "https://demo.viktor.space/reports",
  ]);
  expect(requests).toHaveLength(2);
  expect(
    (await send("https://demo.viktor.space/reports"))["x-viktor-edge-access"],
  ).toBe("t2");
});

test("goto does not retry a 401 on a host it sends no token to", async () => {
  const visited: string[] = [];
  const page = {
    on: () => {},
    goto: async (url: string) => {
      visited.push(url);
      return { status: () => 401 };
    },
  } as unknown as Page;
  const helper = new PageHelper(page, {} as Browser, fakeContext().context);

  await helper.goto("http://localhost:4173/");

  expect(visited).toHaveLength(1);
  expect(requests).toHaveLength(0);
});

type Answer = { status: number; decision?: string; redirectedFrom?: Answer };

function fakeResponse(answer: Answer): unknown {
  const previous = answer.redirectedFrom;
  return {
    status: () => answer.status,
    headers: () =>
      answer.decision ? { "x-edge-gate-decision": answer.decision } : {},
    request: () => ({
      redirectedFrom: () =>
        previous
          ? {
              response: async () => fakeResponse(previous),
              redirectedFrom: () => null,
            }
          : null,
    }),
  };
}

function pageAnswering(...answers: Answer[]) {
  const visited: number[] = [];
  const page = {
    on: () => {},
    goto: async () => {
      visited.push(Date.now());
      return fakeResponse(answers.shift() ?? { status: 200 });
    },
  } as unknown as Page;
  return { page, visited };
}

test("a mint without a token is asked again after 30 s, through a route kept installed", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  setSystemTime(start);
  const { context, handlers, send } = fakeContext();
  const access = new EdgeAccess(context);
  mintsReturning("", "t1");

  await access.attach("https://demo.viktor.space/");

  expect(handlers).toHaveLength(1);
  expect(access.sends("https://demo.viktor.space/")).toBe(true);
  setSystemTime(new Date(start.getTime() + 29_000));
  expect(await send("https://demo.viktor.space/")).toEqual({
    accept: "text/html",
  });
  expect(requests).toHaveLength(1);
  setSystemTime(new Date(start.getTime() + 31_000));
  expect(
    (await send("https://demo.viktor.space/"))["x-viktor-edge-access"],
  ).toBe("t1");
  expect(requests).toHaveLength(2);
});

test("a gate redirect to sign-in after a tokenless mint re-mints once", async () => {
  const { context, send } = fakeContext();
  const { page, visited } = pageAnswering({
    status: 200,
    redirectedFrom: { status: 302, decision: "deny:no_matching_rule" },
  });
  const helper = new PageHelper(page, {} as Browser, context);
  helper.edgeAccessDeniedRetryDelayMs = 0;
  mintsReturning("", "t1");

  await helper.goto("https://demo.viktor.space/reports");

  expect(visited).toHaveLength(2);
  expect(requests).toHaveLength(2);
  expect(
    (await send("https://demo.viktor.space/reports"))["x-viktor-edge-access"],
  ).toBe("t1");
});

test("an app's own redirect is not retried", async () => {
  const { context } = fakeContext();
  const { page, visited } = pageAnswering({
    status: 200,
    redirectedFrom: { status: 302 },
  });
  const helper = new PageHelper(page, {} as Browser, context);
  helper.edgeAccessDeniedRetryDelayMs = 0;
  mintsReturning("t1", "t2");

  await helper.goto("https://demo.viktor.space/old-path");

  expect(visited).toHaveLength(1);
  expect(requests).toHaveLength(1);
});

test("a gate 403 after an access change re-mints once, after a short wait", async () => {
  const { context, send } = fakeContext();
  const { page, visited } = pageAnswering(
    { status: 403, decision: "deny:policy_changed" },
    { status: 403, decision: "deny:policy_changed" },
  );
  const helper = new PageHelper(page, {} as Browser, context);
  helper.edgeAccessDeniedRetryDelayMs = 40;
  mintsReturning("t1", "t2", "t3");

  await helper.goto("https://demo.viktor.space/reports");

  expect(visited).toHaveLength(2);
  expect(visited[1] - visited[0]).toBeGreaterThanOrEqual(35);
  expect(requests).toHaveLength(2);
  expect(
    (await send("https://demo.viktor.space/reports"))["x-viktor-edge-access"],
  ).toBe("t2");
});

test("an app's own 403 is not retried", async () => {
  const { context } = fakeContext();
  const { page, visited } = pageAnswering({ status: 403 });
  const helper = new PageHelper(page, {} as Browser, context);
  helper.edgeAccessDeniedRetryDelayMs = 0;
  mintsReturning("t1", "t2");

  await helper.goto("https://demo.viktor.space/admin");

  expect(visited).toHaveLength(1);
  expect(requests).toHaveLength(1);
});

test("a deployed Space URL gets the edge access header minted with the sandbox credentials", async () => {
  const headers = await edgeAccessHeaders("https://demo.viktor.space/reports");

  expect(headers).toEqual({ "x-viktor-edge-access": "edge-token" });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://api.test/api/viktor-spaces/edge-access-token",
  );
  expect(
    (requests[0].init?.headers as Record<string, string>).Authorization,
  ).toBe("Bearer tool-token");
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({
    project_name: "demo",
    project_secret: "project-secret",
    space_id: "space_demo",
    url: "https://demo.viktor.space/reports",
  });
});

test("the local preview and hosts that are not this Space's get no header", async () => {
  expect(await edgeAccessHeaders("http://localhost:4173/")).toEqual({});
  expect(requests).toHaveLength(0);

  reply = () => Response.json({ success: true, token: null });
  expect(await edgeAccessHeaders("https://example.com/")).toEqual({});
});

test("outside a deployed Space (no sandbox credentials) nothing is minted", async () => {
  delete process.env.TOOL_TOKEN;
  expect(await edgeAccessHeaders("https://demo.viktor.space/")).toEqual({});
  expect(requests).toHaveLength(0);
});

test("a refused mint fails loudly instead of loading the sign-in page", async () => {
  reply = () =>
    Response.json({
      success: false,
      error: "Edge access denied: outside_workspace",
    });
  await expect(edgeAccessHeaders("https://demo.viktor.space/")).rejects.toThrow(
    "Edge access denied: outside_workspace",
  );
  reply = () => new Response("nope", { status: 403 });
  await expect(edgeAccessHeaders("https://demo.viktor.space/")).rejects.toThrow(
    "HTTP 403",
  );
});
