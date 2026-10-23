import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const optStr = v.optional(v.string());

const schema = defineSchema({
  ...authTables,

  // Assessment data model. Field names match the spec; Convex's own _id is internal only —
  // the public identifier is the UUID `patient_id`.
  patients: defineTable({
    patient_id: v.string(), // UUID v4
    first_name: v.string(),
    last_name: v.string(),
    last_name_lower: v.string(), // case-insensitive filter index
    date_of_birth: v.string(), // ISO YYYY-MM-DD (rendered MM/DD/YYYY by the API)
    sex: v.union(v.literal("Male"), v.literal("Female"), v.literal("Other"), v.literal("Decline to Answer")),
    phone_number: v.string(), // 10 digits
    email: optStr,
    address_line_1: v.string(),
    address_line_2: optStr,
    city: v.string(),
    state: v.string(), // 2-letter
    zip_code: v.string(),
    insurance_provider: optStr,
    insurance_member_id: optStr,
    preferred_language: v.string(),
    emergency_contact_name: optStr,
    emergency_contact_phone: optStr,
    created_at: v.number(),
    updated_at: v.number(),
    deleted_at: v.optional(v.number()), // soft delete
  })
    .index("by_patient_id", ["patient_id"])
    .index("by_phone", ["phone_number"])
    .index("by_last_name", ["last_name_lower"])
    .index("by_dob", ["date_of_birth"]),

  // One row per phone call: links transcript/summary/outcome to the patient it created/updated.
  calls: defineTable({
    call_id: v.string(), // Vapi call id
    patient_id: optStr,
    caller_number: optStr,
    outcome: v.string(), // in_progress | registered | updated | incomplete
    ended_reason: optStr,
    summary: optStr,
    transcript: optStr,
    duration_seconds: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_call_id", ["call_id"])
    .index("by_patient", ["patient_id"]),

  // Bonus: mock first-appointment booking.
  appointments: defineTable({
    appointment_id: v.string(),
    patient_id: v.string(),
    scheduled_for: v.string(), // ISO-8601 with offset
    provider_name: v.string(),
    reason: optStr,
    created_at: v.number(),
  })
    .index("by_patient", ["patient_id"])
    .index("by_slot", ["scheduled_for"]),
});

export default schema;
