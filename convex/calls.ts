/** Call log service: links each phone call (transcript/summary/outcome) to a patient record. */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type CallFields = Partial<Omit<Doc<"calls">, "_id" | "_creationTime" | "call_id" | "created_at">>;

export async function upsertCall(ctx: MutationCtx, callId: string, fields: CallFields) {
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
  const existing = await ctx.db
    .query("calls")
    .withIndex("by_call_id", (q) => q.eq("call_id", callId))
    .unique();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, { ...defined, updated_at: now });
    return (await ctx.db.get(existing._id)) as Doc<"calls">;
  }
  const id = await ctx.db.insert("calls", {
    outcome: "in_progress",
    ...defined,
    call_id: callId,
    created_at: now,
    updated_at: now,
  });
  return (await ctx.db.get(id)) as Doc<"calls">;
}

export function callToApi(c: Doc<"calls">) {
  return {
    call_id: c.call_id,
    patient_id: c.patient_id ?? null,
    caller_number: c.caller_number ?? null,
    outcome: c.outcome,
    ended_reason: c.ended_reason ?? null,
    summary: c.summary ?? null,
    transcript: c.transcript ?? null,
    duration_seconds: c.duration_seconds ?? null,
    created_at: new Date(c.created_at).toISOString(),
  };
}
