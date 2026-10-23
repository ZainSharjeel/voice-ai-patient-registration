import { convexAuth } from "@convex-dev/auth/server";
import {
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
  httpActionGeneric,
  httpRouter,
} from "convex/server";
import {
  LOGIN_FAILED_PATH,
  OAUTH_CALLBACK_PATH,
} from "../src/auth/oauthReturn";
import { configuredAuthProviders } from "./viktorSpaceAuthConfig";

declare const process: { env: Record<string, string | undefined> };

const CALLBACK_PATH = "/api/auth/callback/viktor";
const REDIRECT_COOKIE_NAMES = new Set([
  "__Host-viktorRedirectTo",
  "viktorRedirectTo",
]);

type CallbackMethod = "GET" | "POST";

type OAuthCallback = (
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
) => Promise<Response>;

function appRedirect(
  redirectTo: string,
  siteUrl: string,
): { href: string; sameOrigin: boolean } {
  if (/[\\\s]/.test(redirectTo) || redirectTo.startsWith("//")) {
    throw new Error("Invalid auth redirect");
  }
  const destination = new URL(redirectTo, siteUrl);
  if (destination.username || destination.password) {
    throw new Error("Invalid auth redirect");
  }
  if (destination.origin === new URL(siteUrl).origin) {
    return { href: destination.href, sameOrigin: true };
  }
  if (
    destination.protocol !== "https:" ||
    redirectTo !== `${destination.origin}${OAUTH_CALLBACK_PATH}`
  ) {
    throw new Error("Invalid auth redirect");
  }
  return { href: redirectTo, sameOrigin: false };
}

function redirectCookie(request: Request): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (!REDIRECT_COOKIE_NAMES.has(name)) continue;
    const value = entry.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function needsCustomCallback(request: Request, siteUrl: string): boolean {
  const redirectTo = redirectCookie(request);
  if (!redirectTo) return false;
  try {
    return !appRedirect(redirectTo, siteUrl).sameOrigin;
  } catch {
    return true;
  }
}

function oauthCallback(
  http: HttpRouter,
  method: CallbackMethod,
): OAuthCallback | undefined {
  const match = http.lookup(CALLBACK_PATH, method);
  if (!match) return undefined;
  return (match[0] as unknown as { _handler: OAuthCallback })._handler;
}

async function handleCustomDomainCallback(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
  siteUrl: string,
  method: CallbackMethod,
): Promise<Response> {
  let requestedRedirect: string | undefined;
  let approvedRedirect: string | undefined;

  const { auth } = convexAuth({
    providers: configuredAuthProviders({
      requested: () =>
        requestedRedirect
          ? { siteUrl, redirectTo: requestedRedirect }
          : undefined,
      approved: redirectTo => {
        approvedRedirect = redirectTo;
      },
    }),
    callbacks: {
      redirect: async ({ redirectTo }) => {
        const destination = appRedirect(redirectTo, siteUrl);
        if (destination.sameOrigin) return destination.href;
        requestedRedirect = destination.href;
        return `${siteUrl}${OAUTH_CALLBACK_PATH}`;
      },
    },
  });
  const routes = httpRouter();
  auth.addHttpRoutes(routes);
  const callback = oauthCallback(routes, method);
  if (!callback)
    return new Response("Viktor sign-in is not configured", { status: 404 });

  const response = await callback(ctx, request);
  if (!requestedRedirect) return response;
  if (approvedRedirect !== requestedRedirect) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${siteUrl}${LOGIN_FAILED_PATH}`,
        "Cache-Control": "no-store",
      },
    });
  }

  const location = response.headers.get("Location");
  if (!location) return response;
  const destination = new URL(location);
  if (
    destination.origin !== new URL(siteUrl).origin ||
    destination.pathname !== OAUTH_CALLBACK_PATH
  ) {
    throw new Error("Unexpected Convex OAuth callback destination");
  }
  const approved = new URL(approvedRedirect);
  approved.search = destination.search;
  const headers = new Headers(response.headers);
  headers.set("Location", approved.href);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export function addViktorAuthCallbackRoutes(http: HttpRouter): void {
  for (const method of ["GET", "POST"] as const) {
    const stockCallback = oauthCallback(http, method);
    if (!stockCallback) continue;
    const handler = httpActionGeneric(async (ctx, request) => {
      const siteUrl = process.env.SITE_URL?.replace(/\/$/, "");
      if (!siteUrl || !needsCustomCallback(request, siteUrl)) {
        return stockCallback(ctx, request);
      }
      return handleCustomDomainCallback(ctx, request, siteUrl, method);
    });
    http.route({ path: CALLBACK_PATH, method, handler });
  }
}
