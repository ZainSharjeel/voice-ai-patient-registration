/**
 * Patient service layer — the single place that reads/writes patients.
 * Used by BOTH the REST API (convex/restApi.ts) and the voice-agent tools (convex/agent.ts), so
 * validation and business rules have exactly one implementation.
 */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { formatDob, PATIENT_FIELDS } from "./validation";

export class NotFoundError extends Error {}

export type PatientOut = Record<string, string | null>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Public JSON shape: spec field names, DOB as MM/DD/YYYY, ISO-8601 UTC timestamps. */
export function toApi(p: Doc<"patients">): PatientOut {
  const out: PatientOut = { patient_id: p.patient_id };
  for (const f of PATIENT_FIELDS) out[f] = (p[f] as string | undefined) ?? null;
  out.date_of_birth = formatDob(p.date_of_birth);
  out.created_at = iso(p.created_at);
  out.updated_at = iso(p.updated_at);
  return out;
}

export async function getActive(ctx: QueryCtx, patientId: string): Promise<Doc<"patients">> {
  const p = await ctx.db
    .query("patients")
    .withIndex("by_patient_id", (q) => q.eq("patient_id", patientId))
    .unique();
  if (!p || p.deleted_at !== undefined) throw new NotFoundError(`Patient ${patientId} not found.`);
  return p;
}

export async function listActive(
  ctx: QueryCtx,
  f: { last_name?: string; date_of_birth?: string; phone_number?: string; limit: number; offset: number },
): Promise<Doc<"patients">[]> {
  // Use the most selective index available, then apply the remaining filters.
  const base = ctx.db.query("patients");
  const indexed = f.phone_number
    ? base.withIndex("by_phone", (q) => q.eq("phone_number", f.phone_number as string))
    : f.last_name
      ? base.withIndex("by_last_name", (q) => q.eq("last_name_lower", (f.last_name as string).toLowerCase()))
      : f.date_of_birth
        ? base.withIndex("by_dob", (q) => q.eq("date_of_birth", f.date_of_birth as string))
        : base;
  const rows = await indexed
    .order("desc")
    .filter((q) => {
      const conds = [q.eq(q.field("deleted_at"), undefined)];
      if (f.last_name) conds.push(q.eq(q.field("last_name_lower"), f.last_name.toLowerCase()));
      if (f.date_of_birth) conds.push(q.eq(q.field("date_of_birth"), f.date_of_birth));
      if (f.phone_number) conds.push(q.eq(q.field("phone_number"), f.phone_number));
      return q.and(...conds);
    })
    .take(f.offset + f.limit);
  return rows.slice(f.offset);
}

export async function findByPhone(ctx: QueryCtx, phone: string) {
  return listActive(ctx, { phone_number: phone, limit: 5, offset: 0 });
}

/** `values` must come from validatePatient(..., "create"). */
export async function createPatient(ctx: MutationCtx, values: Record<string, string | null>) {
  const now = Date.now();
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as Record<string, string>;
  const id = await ctx.db.insert("patients", {
    ...(clean as unknown as Omit<Doc<"patients">, "_id" | "_creationTime">),
    patient_id: crypto.randomUUID(),
    last_name_lower: clean.last_name.toLowerCase(),
    created_at: now,
    updated_at: now,
  });
  const p = (await ctx.db.get(id)) as Doc<"patients">;
  console.log(`patient.created id=${p.patient_id}`);
  return p;
}

/** `values` must come from validatePatient(..., "update"); null clears an optional field. */
export async function updatePatient(ctx: MutationCtx, patientId: string, values: Record<string, string | null>) {
  const p = await getActive(ctx, patientId);
  const patch: Record<string, unknown> = { updated_at: Date.now() };
  for (const [k, v] of Object.entries(values)) patch[k] = v === null ? undefined : v;
  if (values.last_name) patch.last_name_lower = values.last_name.toLowerCase();
  await ctx.db.patch(p._id, patch);
  console.log(`patient.updated id=${patientId} fields=${Object.keys(values).sort().join(",")}`);
  return (await ctx.db.get(p._id)) as Doc<"patients">;
}

export async function softDeletePatient(ctx: MutationCtx, patientId: string) {
  const p = await getActive(ctx, patientId);
  const now = Date.now();
  await ctx.db.patch(p._id, { deleted_at: now, updated_at: now });
  console.log(`patient.soft_deleted id=${patientId}`);
  return { patient_id: patientId, deleted_at: iso(now) };
}
