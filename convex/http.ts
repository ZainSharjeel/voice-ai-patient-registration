// PHI console redaction (active only on PHI deployments).
import "./phiLogging";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { SYSTEM_ERROR } from "./agent";
import { auth } from "./auth";
import { type ApiResult, fail } from "./restApi";
import { PATIENT_FIELDS } from "./validation";

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();
// Registers Convex Auth's routes (template plumbing; the patient API itself is unauthenticated).
auth.addHttpRoutes(http);

// Convex returns object keys sorted; restore the spec's field order for readability.
const KEY_ORDER = ["data", "error", "meta", "patient_id", ...PATIENT_FIELDS, "created_at", "updated_at"];
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, ordered(v)] as const);
  const rank = (k: string) => (KEY_ORDER.includes(k) ? KEY_ORDER.indexOf(k) : KEY_ORDER.length);
  return Object.fromEntries(entries.sort(([a], [b]) => rank(a) - rank(b)));
}

const send = ({ status, body }: ApiResult) =>
  Response.json(ordered(body), { status, headers: { "Access-Control-Allow-Origin": "*" } });

/** Thin wrapper: parse the request, delegate to an internal function, never leak a bare 500. */
const route = (fn: (ctx: Parameters<Parameters<typeof httpAction>[0]>[0], req: Request, url: URL) => Promise<ApiResult>) =>
  httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    try {
      const res = await fn(ctx, req, url);
      console.log(`http ${req.method} ${url.pathname} -> ${res.status}`);
      return send(res);
    } catch (e) {
      console.error(`http ${req.method} ${url.pathname} -> 500`, e);
      return send(fail(500, "internal_error", "An unexpected error occurred."));
    }
  });

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: ApiResult }> {
  const text = await req.text();
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: fail(400, "bad_request", "Request body is not valid JSON.") };
  }
}

// ---- Patients -------------------------------------------------------------------------------------
const listPatients = route((ctx, _req, url) =>
  ctx.runQuery(internal.restApi.list, { params: Object.fromEntries(url.searchParams) }),
);
const createPatient = route(async (ctx, req) => {
  const parsed = await readJson(req);
  return parsed.ok ? ctx.runMutation(internal.restApi.create, { body: parsed.body }) : parsed.res;
});
http.route({ path: "/patients", method: "GET", handler: listPatients });
http.route({ path: "/patients", method: "POST", handler: createPatient });

/** /patients/{id}, /patients/{id}/calls, /patients/{id}/appointments */
function parsePath(url: URL): { id: string; sub?: string } | null {
  const parts = url.pathname.replace(/^\/patients\/?/, "").split("/").filter(Boolean);
  if (parts.length === 1) return { id: parts[0] };
  if (parts.length === 2 && ["calls", "appointments"].includes(parts[1])) return { id: parts[0], sub: parts[1] };
  return null;
}
const notFound = () => fail(404, "not_found", "Route not found.");

http.route({
  pathPrefix: "/patients/",
  method: "GET",
  handler: route(async (ctx, req, url) => {
    if (url.pathname === "/patients/") return ctx.runQuery(internal.restApi.list, { params: Object.fromEntries(url.searchParams) });
    const p = parsePath(url);
    if (!p) return notFound();
    if (p.sub === "calls") return ctx.runQuery(internal.restApi.patientCalls, { id: p.id });
    if (p.sub === "appointments") return ctx.runQuery(internal.restApi.patientAppointments, { id: p.id });
    void req;
    return ctx.runQuery(internal.restApi.get, { id: p.id });
  }),
});
http.route({
  pathPrefix: "/patients/",
  method: "PUT",
  handler: route(async (ctx, req, url) => {
    const p = parsePath(url);
    if (!p || p.sub) return notFound();
    const parsed = await readJson(req);
    return parsed.ok ? ctx.runMutation(internal.restApi.update, { id: p.id, body: parsed.body }) : parsed.res;
  }),
});
http.route({
  pathPrefix: "/patients/",
  method: "DELETE",
  handler: route(async (ctx, _req, url) => {
    const p = parsePath(url);
    if (!p || p.sub) return notFound();
    return ctx.runMutation(internal.restApi.remove, { id: p.id });
  }),
});

http.route({ path: "/calls", method: "GET", handler: route((ctx) => ctx.runQuery(internal.restApi.listCalls, {})) });

http.route({
  path: "/health",
  method: "GET",
  handler: route(async (ctx) => {
    await ctx.runQuery(internal.restApi.listCalls, {}); // proves the database is reachable
    return { status: 200, body: { data: { status: "ok", database: "convex" }, error: null } };
  }),
});

// ---- Vapi voice-agent webhook -------------------------------------------------------------------
// The only Vapi-specific code: translates Vapi server messages <-> provider-agnostic tools.
http.route({
  path: "/vapi/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.VAPI_WEBHOOK_SECRET;
    if (expected && req.headers.get("x-vapi-secret") !== expected) {
      return send(fail(401, "unauthorized", "Invalid webhook secret."));
    }
    const parsed = await readJson(req);
    if (!parsed.ok) return send(parsed.res);
    const message = ((parsed.body as { message?: Record<string, any> })?.message ?? {}) as Record<string, any>;
    const call = message.call ?? {};
    const callId: string | undefined = call.id;
    const callerNumber: string | undefined = (message.customer ?? call.customer ?? {}).number;

    if (message.type === "tool-calls") {
      const results = [];
      for (const tc of message.toolCallList ?? []) {
        const fn = tc.function ?? {};
        let result: Record<string, unknown>;
        try {
          result = await ctx.runMutation(internal.agent.runTool, { name: fn.name ?? "", args: fn.arguments ?? {}, callId, callerNumber });
        } catch (e) {
          console.error(`agent.tool_crashed call_id=${callId} tool=${fn.name}`, e);
          result = SYSTEM_ERROR; // the mutation rolled back; tell the caller honestly
        }
        console.log(`vapi.tool_result call_id=${callId} tool=${fn.name} success=${result.success}`);
        results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
      }
      return Response.json({ results });
    }

    if (message.type === "end-of-call-report" && callId) {
      const transcript: string | undefined = message.artifact?.transcript ?? message.transcript;
      console.log(`vapi.end_of_call call_id=${callId} ended_reason=${message.endedReason}\n--- transcript ---\n${transcript}`);
      await ctx.runMutation(internal.agent.endOfCall, {
        callId, callerNumber, transcript,
        summary: message.analysis?.summary ?? message.summary,
        endedReason: message.endedReason,
        durationSeconds: typeof message.durationSeconds === "number" ? message.durationSeconds : undefined,
      });
    } else if (message.type === "status-update") {
      console.log(`vapi.status call_id=${callId} status=${message.status}`);
      if (callId && message.status === "in-progress") await ctx.runMutation(internal.agent.callStarted, { callId, callerNumber });
    }
    return Response.json({ ok: true });
  }),
});

export default http;
