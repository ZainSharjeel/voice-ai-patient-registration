/** Read-only data for the public demo dashboard (reviewers see registrations + call transcripts live). */
import { query } from "./_generated/server";
import { appointmentToApi } from "./appointments";
import { callToApi } from "./calls";
import { toApi } from "./patients";

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const patients = await ctx.db
      .query("patients")
      .order("desc")
      .filter((q) => q.eq(q.field("deleted_at"), undefined))
      .take(200);
    const calls = await ctx.db.query("calls").order("desc").take(100);
    const appointments = await ctx.db.query("appointments").order("desc").take(100);
    return {
      patients: patients.map(toApi),
      calls: calls.map(callToApi),
      appointments: appointments.map(appointmentToApi),
    };
  },
});
