/**
 * End-to-end tests against a running deployment (REST API + simulated Vapi webhook traffic).
 *   API_BASE_URL=https://<deployment>.convex.site VAPI_WEBHOOK_SECRET=... bun test tests/api.e2e.test.ts
 */
import { describe, expect, test } from "bun:test";

const BASE = process.env.API_BASE_URL as string;
const SECRET = process.env.VAPI_WEBHOOK_SECRET ?? "";
if (!BASE) throw new Error("Set API_BASE_URL");

const uniquePhone = () => `415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const newPatient = () => ({
  first_name: "Test", last_name: "O'Connor-Lee", date_of_birth: "07/04/1991", sex: "Female", phone_number: uniquePhone(),
  address_line_1: "500 Howard St", city: "San Francisco", state: "California", zip_code: "94105",
});

async function api(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function vapi(message: Record<string, unknown>, secret = SECRET) {
  const res = await fetch(`${BASE}/vapi/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "x-vapi-secret": secret }, body: JSON.stringify({ message }),
  });
  return { status: res.status, json: (await res.json()) as any };
}
const toolCall = async (callId: string, name: string, args: Record<string, unknown>) => {
  const r = await vapi({ type: "tool-calls", call: { id: callId, customer: { number: "+14155550000" } },
    toolCallList: [{ id: `tc-${name}`, function: { name, arguments: args } }] });
  expect(r.status).toBe(200);
  expect(r.json.results[0].toolCallId).toBe(`tc-${name}`);
  return JSON.parse(r.json.results[0].result);
};

describe("REST API", () => {
  test("create -> get -> filter -> update -> soft delete", async () => {
    const created = await api("POST", "/patients", newPatient());
    expect(created.status).toBe(201);
    expect(created.json.error).toBeNull();
    const p = created.json.data;
    expect(p.patient_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.state).toBe("CA");
    expect(p.preferred_language).toBe("English");
    expect(p.date_of_birth).toBe("07/04/1991");

    expect((await api("GET", `/patients/${p.patient_id}`)).json.data.phone_number).toBe(p.phone_number);
    const byPhone = await api("GET", `/patients?phone_number=(${p.phone_number.slice(0, 3)}) ${p.phone_number.slice(3, 6)}-${p.phone_number.slice(6)}`);
    expect(byPhone.json.data.map((x: any) => x.patient_id)).toContain(p.patient_id);
    const byNameDob = await api("GET", "/patients?last_name=o'connor-lee&date_of_birth=1991-07-04");
    expect(byNameDob.json.data.map((x: any) => x.patient_id)).toContain(p.patient_id);

    const upd = await api("PUT", `/patients/${p.patient_id}`, { city: "Oakland", email: "test@example.com" });
    expect(upd.status).toBe(200);
    expect(upd.json.data.city).toBe("Oakland");
    expect(upd.json.data.first_name).toBe("Test");

    const del = await api("DELETE", `/patients/${p.patient_id}`);
    expect(del.status).toBe(200);
    expect(del.json.data.deleted_at).toBeTruthy();
    expect((await api("GET", `/patients/${p.patient_id}`)).status).toBe(404);
    expect((await api("GET", `/patients?phone_number=${p.phone_number}`)).json.data).toEqual([]);
  });

  test("status codes and envelope on errors", async () => {
    const bad = await api("POST", "/patients", { ...newPatient(), phone_number: "555", date_of_birth: "01/01/2999" });
    expect(bad.status).toBe(422);
    expect(bad.json.data).toBeNull();
    expect(bad.json.error.details.map((d: any) => d.field).sort()).toEqual(["date_of_birth", "phone_number"]);
    expect((await api("POST", "/patients", undefined, "{nope")).status).toBe(400);
    expect((await api("POST", "/patients", [1, 2])).status).toBe(400);
    expect((await api("GET", "/patients/not-a-uuid")).status).toBe(400);
    expect((await api("GET", "/patients/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api("PUT", "/patients/00000000-0000-4000-8000-000000000000", { city: "X" })).status).toBe(404);
    expect((await api("GET", "/patients?date_of_birth=13/45/2000")).status).toBe(400);
    expect((await api("GET", "/health")).json.data.status).toBe("ok");
  });
});

describe("Voice agent webhook (simulated Vapi traffic)", () => {
  test("rejects a wrong secret", async () => {
    if (!SECRET) return;
    expect((await vapi({ type: "status-update" }, "wrong")).status).toBe(401);
  });

  test("full call: lookup -> invalid field re-prompt -> register -> duplicate -> appointment -> transcript", async () => {
    const callId = `test-call-${Date.now()}`;
    const p = newPatient();
    await vapi({ type: "status-update", status: "in-progress", call: { id: callId, customer: { number: "+14155550000" } } });

    expect((await toolCall(callId, "find_patient_by_phone", { phone_number: p.phone_number })).found).toBe(false);

    const invalid = await toolCall(callId, "register_patient", { ...p, date_of_birth: "02/30/1991" });
    expect(invalid.success).toBe(false);
    expect(invalid.invalid_fields).toEqual([{ field: "date_of_birth", message: expect.stringContaining("real date") }]);
    expect(invalid.instruction).toContain("ONLY that item");

    const ok = await toolCall(callId, "register_patient", p);
    expect(ok.success).toBe(true);
    expect(ok.instruction).toContain("You're all set, Test");

    const dup = await toolCall(`${callId}-b`, "register_patient", { ...p, first_name: "Other" });
    expect(dup.error).toBe("possible_duplicate");
    expect(dup.instruction).toContain("we already have a record for Test O'Connor-Lee");
    const found = await toolCall(`${callId}-b`, "find_patient_by_phone", { phone_number: p.phone_number });
    expect(found.patient.patient_id).toBe(ok.patient_id);

    const upd = await toolCall(`${callId}-b`, "update_patient", { patient_id: ok.patient_id, zip_code: "94107" });
    expect(upd.success).toBe(true);
    expect(upd.patient.zip_code).toBe("94107");

    const slots = await toolCall(callId, "get_appointment_slots", {});
    expect(slots.slots.length).toBeGreaterThan(0);
    const booked = await toolCall(callId, "book_appointment", { patient_id: ok.patient_id, slot_start: slots.slots[0].slot_start });
    expect(booked.success).toBe(true);
    const again = await toolCall(callId, "book_appointment", { patient_id: ok.patient_id, slot_start: slots.slots[0].slot_start });
    expect(again.success).toBe(false);

    await vapi({ type: "end-of-call-report", call: { id: callId }, endedReason: "assistant-ended-call", durationSeconds: 182,
      artifact: { transcript: "AI: Hi...\nUser: ..." }, analysis: { summary: "Registered Test O'Connor-Lee." } });
    const calls = await api("GET", `/patients/${ok.patient_id}/calls`);
    const c = calls.json.data.find((x: any) => x.call_id === callId);
    expect(c.outcome).toBe("registered");
    expect(c.transcript).toContain("AI: Hi");
    expect((await api("GET", `/patients/${ok.patient_id}/appointments`)).json.data).toHaveLength(1);

    // Dropped call (no save) is kept for follow-up as "incomplete".
    const dropped = `${callId}-dropped`;
    await vapi({ type: "end-of-call-report", call: { id: dropped }, endedReason: "customer-ended-call", artifact: { transcript: "AI: Hi" } });
    expect((await api("GET", "/calls")).json.data.find((x: any) => x.call_id === dropped).outcome).toBe("incomplete");

    await api("DELETE", `/patients/${ok.patient_id}`); // keep the demo data clean
  });
});
