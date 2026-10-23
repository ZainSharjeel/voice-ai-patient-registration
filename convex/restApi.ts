/**
 * REST API handlers. Each returns a ready-to-send {status, body} with the spec's envelope
 * ({"data": ..., "error": null} | {"data": null, "error": {...}}) so convex/http.ts stays a thin router.
 * Mutations are transactional: a request either fully applies or not at all.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { appointmentToApi } from "./appointments";
import { callToApi } from "./calls";
import { createPatient, getActive, listActive, NotFoundError, softDeletePatient, toApi, updatePatient } from "./patients";
import { seedIfEmpty } from "./seed";
import { UUID_RE, ValidationError, validateDob, validatePatient, validateUsPhone } from "./validation";

export type ApiResult = { status: number; body: { data: unknown; error: unknown; meta?: unknown } };

export const ok = (data: unknown, status = 200, meta?: unknown): ApiResult => ({
  status,
  body: meta === undefined ? { data, error: null } : { data, error: null, meta },
});
export const fail = (status: number, code: string, message: string, details?: unknown): ApiResult => ({
  status,
  body: { data: null, error: details ? { code, message, details } : { code, message } },
});

/** Maps domain errors to HTTP semantics in one place. */
function handle(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  return fn().catch((e: unknown) => {
    if (e instanceof ValidationError) {
      const bodyShape = e.details.length === 1 && e.details[0].field === null && /JSON object/.test(e.details[0].message);
      return bodyShape
        ? fail(400, "bad_request", e.details[0].message)
        : fail(422, "validation_error", "One or more fields are invalid.", e.details);
    }
    if (e instanceof NotFoundError) return fail(404, "not_found", e.message);
    console.error("api.unhandled_error", e);
    return fail(500, "internal_error", "An unexpected error occurred.");
  });
}

function checkId(id: string): ApiResult | null {
  return UUID_RE.test(id) ? null : fail(400, "bad_request", "patient_id must be a valid UUID.");
}

export const list = internalQuery({
  args: { params: v.record(v.string(), v.string()) },
  handler: (ctx, { params }) =>
    handle(async () => {
      const limit = params.limit === undefined ? 100 : Number(params.limit);
      const offset = params.offset === undefined ? 0 : Number(params.offset);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(400, "bad_request", "limit must be an integer between 1 and 500.");
      if (!Number.isInteger(offset) || offset < 0) return fail(400, "bad_request", "offset must be a non-negative integer.");
      let dob: string | undefined;
      let phone: string | undefined;
      try {
        dob = params.date_of_birth ? validateDob(params.date_of_birth) : undefined;
        phone = params.phone_number ? validateUsPhone(params.phone_number) : undefined;
      } catch (e) {
        return fail(400, "bad_request", (e as Error).message);
      }
      const rows = await listActive(ctx, {
        last_name: params.last_name?.trim() || undefined, date_of_birth: dob, phone_number: phone, limit, offset,
      });
      return ok(rows.map(toApi), 200, { count: rows.length, limit, offset });
    }),
});

export const get = internalQuery({
  args: { id: v.string() },
  handler: (ctx, { id }) => handle(async () => checkId(id) ?? ok(toApi(await getActive(ctx, id)))),
});

export const create = internalMutation({
  args: { body: v.any() },
  handler: (ctx, { body }) =>
    handle(async () => {
      const values = validatePatient(body, "create");
      console.log(`api.create_payload ${JSON.stringify(values)}`);
      return ok(toApi(await createPatient(ctx, values)), 201);
    }),
});

export const update = internalMutation({
  args: { id: v.string(), body: v.any() },
  handler: (ctx, { id, body }) =>
    handle(async () => checkId(id) ?? ok(toApi(await updatePatient(ctx, id, validatePatient(body, "update"))))),
});

export const remove = internalMutation({
  args: { id: v.string() },
  handler: (ctx, { id }) => handle(async () => checkId(id) ?? ok(await softDeletePatient(ctx, id))),
});

export const patientCalls = internalQuery({
  args: { id: v.string() },
  handler: (ctx, { id }) =>
    handle(async () => {
      const bad = checkId(id);
      if (bad) return bad;
      await getActive(ctx, id);
      const rows = await ctx.db.query("calls").withIndex("by_patient", (q) => q.eq("patient_id", id)).order("desc").take(100);
      return ok(rows.map(callToApi));
    }),
});

export const patientAppointments = internalQuery({
  args: { id: v.string() },
  handler: (ctx, { id }) =>
    handle(async () => {
      const bad = checkId(id);
      if (bad) return bad;
      await getActive(ctx, id);
      const rows = await ctx.db.query("appointments").withIndex("by_patient", (q) => q.eq("patient_id", id)).take(100);
      return ok(rows.map(appointmentToApi));
    }),
});

export const listCalls = internalQuery({
  args: {},
  handler: (ctx) => handle(async () => ok((await ctx.db.query("calls").order("desc").take(100)).map(callToApi))),
});

export const seed = internalMutation({ args: {}, handler: (ctx) => seedIfEmpty(ctx) });
