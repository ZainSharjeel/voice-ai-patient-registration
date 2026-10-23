/**
 * Voice-agent tool implementations (provider-agnostic) + call bookkeeping.
 *
 * Each tool takes the LLM's arguments and returns an object serialized back to the LLM. Results
 * always include an `instruction` hint so the agent knows what to say next — including on failure,
 * so the caller never hears silence or a false "you're saved". Tools call the same service layer
 * and validators as POST /patients (one code path for business rules).
 */
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { availableSlots, book } from "./appointments";
import { upsertCall } from "./calls";
import { createPatient, findByPhone, NotFoundError, toApi, updatePatient } from "./patients";
import { formatDob, UUID_RE, ValidationError, validatePatient, validateUsPhone } from "./validation";

type Ctx = { callId?: string; callerNumber?: string };
type ToolResult = Record<string, unknown>;

export const SYSTEM_ERROR: ToolResult = {
  success: false,
  error: "system_error",
  instruction:
    "Apologize briefly: tell the caller you hit a technical problem saving their information, so it was NOT saved. " +
    "Offer to try once more, or suggest they call back a little later. Do not pretend it succeeded.",
};

const invalid = (e: ValidationError): ToolResult => ({
  success: false,
  error: "validation_failed",
  invalid_fields: e.details,
  instruction:
    "Nothing was saved. Tell the caller which specific item needs fixing (in plain words, one at a time), " +
    "ask again for ONLY that item, then call the tool again with the corrected value.",
});

/** Keep only patient fields the model actually filled (models sometimes send "" for unknowns). */
function patientArgs(args: Record<string, unknown>) {
  const { patient_id: _p, allow_duplicate_phone: _a, ...rest } = args;
  return Object.fromEntries(Object.entries(rest).filter(([, val]) => val !== null && val !== undefined && val !== ""));
}

async function linkCall(ctx: MutationCtx, c: Ctx, patientId: string, outcome: string) {
  if (c.callId) await upsertCall(ctx, c.callId, { patient_id: patientId, outcome, caller_number: c.callerNumber });
}

const tools: Record<string, (ctx: MutationCtx, args: Record<string, unknown>, c: Ctx) => Promise<ToolResult>> = {
  async find_patient_by_phone(ctx, args) {
    let phone: string;
    try {
      phone = validateUsPhone(args.phone_number ?? "");
    } catch (e) {
      return { success: false, error: "invalid_phone", message: (e as Error).message,
        instruction: "Ask the caller to repeat their 10-digit phone number." };
    }
    const [p] = await findByPhone(ctx, phone);
    if (!p) return { success: true, found: false, instruction: "No existing record. Continue registration." };
    return {
      success: true, found: true,
      patient: { patient_id: p.patient_id, first_name: p.first_name, last_name: p.last_name, date_of_birth: formatDob(p.date_of_birth) },
      instruction:
        `Say: 'It looks like we already have a record for ${p.first_name} ${p.last_name}. Would you like to update your information instead?' ` +
        "If yes, verify identity by asking for their date of birth (must match) before changing anything, then use update_patient. " +
        "If it's a different person (e.g. a family member sharing the phone), continue a new registration and pass allow_duplicate_phone=true.",
    };
  },

  async register_patient(ctx, args, c) {
    let values: Record<string, string | null>;
    try {
      values = validatePatient(patientArgs(args), "create", { ignoreUnknown: true });
    } catch (e) {
      if (e instanceof ValidationError) return invalid(e);
      throw e;
    }
    if (!args.allow_duplicate_phone) {
      const [p] = await findByPhone(ctx, values.phone_number as string);
      if (p) {
        return {
          success: false, error: "possible_duplicate",
          existing_patient: { patient_id: p.patient_id, first_name: p.first_name, last_name: p.last_name },
          instruction:
            `Nothing saved yet. Say: 'It looks like we already have a record for ${p.first_name} ${p.last_name}. Would you like to update your information instead?' ` +
            "Update -> update_patient. New person -> call register_patient again with allow_duplicate_phone=true.",
        };
      }
    }
    // Requirement: log the final structured payload before saving.
    console.log(`agent.final_payload call_id=${c.callId} payload=${JSON.stringify(values)}`);
    const p = await createPatient(ctx, values);
    await linkCall(ctx, c, p.patient_id, "registered");
    return {
      success: true, patient_id: p.patient_id,
      instruction: `Saved. Tell the caller 'You're all set, ${p.first_name}.' Then offer to schedule a first appointment. If they decline, say a warm goodbye and end the call.`,
    };
  },

  async update_patient(ctx, args, c) {
    const pid = String(args.patient_id ?? "");
    if (!UUID_RE.test(pid)) return { success: false, error: "invalid_patient_id", instruction: "Call find_patient_by_phone first to get the patient_id." };
    let values: Record<string, string | null>;
    try {
      values = validatePatient(patientArgs(args), "update", { ignoreUnknown: true });
    } catch (e) {
      if (e instanceof ValidationError) return invalid(e);
      throw e;
    }
    console.log(`agent.update_payload call_id=${c.callId} patient_id=${pid} payload=${JSON.stringify(values)}`);
    try {
      const p = await updatePatient(ctx, pid, values);
      await linkCall(ctx, c, p.patient_id, "updated");
      return { success: true, patient: toApi(p), instruction: `Updated. Tell the caller 'You're all set, ${p.first_name}.'` };
    } catch (e) {
      if (e instanceof NotFoundError) return { success: false, error: "not_found", instruction: "That record no longer exists. Offer to register them as a new patient." };
      throw e;
    }
  },

  async get_appointment_slots(ctx) {
    return { success: true, slots: (await availableSlots(ctx)).slice(0, 6),
      instruction: "Offer two or three of these times in natural speech (use the `spoken` text)." };
  },

  async book_appointment(ctx, args) {
    try {
      const a = await book(ctx, String(args.patient_id ?? ""), String(args.slot_start ?? ""), args.reason ? String(args.reason) : undefined);
      return { success: true, appointment_id: a.appointment_id, provider_name: a.provider_name,
        instruction: "Confirm the day, time and doctor, then say goodbye and end the call." };
    } catch (e) {
      return { success: false, error: (e as Error).message,
        instruction: "Apologize and offer the other available times (call get_appointment_slots)." };
    }
  },
};

export const TOOL_NAMES = Object.keys(tools);

export const runTool = internalMutation({
  args: { name: v.string(), args: v.any(), callId: v.optional(v.string()), callerNumber: v.optional(v.string()) },
  handler: async (ctx, { name, args, callId, callerNumber }): Promise<ToolResult> => {
    const fn = tools[name];
    if (!fn) return { success: false, error: `unknown tool ${name}` };
    let parsed = args;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed || "{}"); } catch { parsed = {}; }
    }
    console.log(`agent.tool_call call_id=${callId} tool=${name}`);
    return fn(ctx, (parsed ?? {}) as Record<string, unknown>, { callId, callerNumber });
  },
});

export const callStarted = internalMutation({
  args: { callId: v.string(), callerNumber: v.optional(v.string()) },
  handler: async (ctx, { callId, callerNumber }) => {
    await upsertCall(ctx, callId, { caller_number: callerNumber });
  },
});

/** Persist transcript + summary. A call that ends without a save is stored as outcome=incomplete
 * (dropped call / caller hung up mid-registration) so staff can follow up. */
export const endOfCall = internalMutation({
  args: {
    callId: v.string(), callerNumber: v.optional(v.string()), transcript: v.optional(v.string()),
    summary: v.optional(v.string()), endedReason: v.optional(v.string()), durationSeconds: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const existing = await upsertCall(ctx, a.callId, { caller_number: a.callerNumber });
    const outcome = ["registered", "updated"].includes(existing.outcome) ? existing.outcome : "incomplete";
    await upsertCall(ctx, a.callId, {
      transcript: a.transcript, summary: a.summary, ended_reason: a.endedReason,
      duration_seconds: a.durationSeconds, outcome,
    });
  },
});
