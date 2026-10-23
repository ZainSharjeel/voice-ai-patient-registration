/** Bonus: mock appointment scheduling. Slots are generated (next business days) — no real calendar. */
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getActive } from "./patients";

export const CLINIC_TZ = "America/New_York";
const PROVIDERS = ["Dr. Sarah Mitchell", "Dr. James Patel"];
const SLOT_TIMES: [number, number][] = [[9, 0], [11, 30], [14, 0], [16, 0]];

/** Minutes east of UTC for `tz` at instant `ms` (e.g. -240 for EDT). */
function tzOffsetMinutes(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** Wall-clock time in the clinic timezone -> ISO-8601 string with offset. */
function clinicIso(y: number, mo: number, d: number, h: number, mi: number): string {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = tzOffsetMinutes(guess - tzOffsetMinutes(guess, CLINIC_TZ) * 60000, CLINIC_TZ);
  const sign = off < 0 ? "-" : "+";
  return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

export async function availableSlots(ctx: QueryCtx, days = 3) {
  const now = Date.now();
  const local = new Date(now + tzOffsetMinutes(now, CLINIC_TZ) * 60000); // clinic wall clock, as UTC fields
  const slots: { slot_start: string; date: string; spoken: string; provider_name: string }[] = [];
  const dates = new Set<string>();
  for (let i = 1; dates.size < days && i < 14; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    dates.add(`${y}-${mo}-${d}`);
    for (const [idx, [h, mi]] of SLOT_TIMES.entries()) {
      const start = clinicIso(y, mo, d, h, mi);
      const taken = await ctx.db
        .query("appointments")
        .withIndex("by_slot", (q) => q.eq("scheduled_for", start))
        .first();
      if (taken) continue;
      const hr = h % 12 || 12;
      const time = mi ? `${hr}:${pad(mi)}` : `${hr}`;
      slots.push({
        slot_start: start,
        date: `${y}-${pad(mo + 1)}-${pad(d)}`,
        spoken: `${DAYS[dow]}, ${MONTHS[mo]} ${d} at ${time} ${h < 12 ? "AM" : "PM"}`,
        provider_name: PROVIDERS[idx % PROVIDERS.length],
      });
    }
  }
  return slots;
}

export async function book(ctx: MutationCtx, patientId: string, slotStart: string, reason?: string) {
  await getActive(ctx, patientId); // throws NotFoundError
  const match = (await availableSlots(ctx, 5)).find((s) => s.slot_start === slotStart);
  if (!match) throw new Error("That time slot is no longer available.");
  const id = await ctx.db.insert("appointments", {
    appointment_id: crypto.randomUUID(),
    patient_id: patientId,
    scheduled_for: slotStart,
    provider_name: match.provider_name,
    reason: reason || undefined,
    created_at: Date.now(),
  });
  return (await ctx.db.get(id)) as Doc<"appointments">;
}

export function appointmentToApi(a: Doc<"appointments">) {
  return {
    appointment_id: a.appointment_id,
    patient_id: a.patient_id,
    scheduled_for: a.scheduled_for,
    provider_name: a.provider_name,
    reason: a.reason ?? null,
  };
}
