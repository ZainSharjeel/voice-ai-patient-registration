/** Demo records so the API/dashboard are not empty on first boot (and to demo duplicate detection). */
import type { MutationCtx } from "./_generated/server";
import { createPatient } from "./patients";
import { validatePatient } from "./validation";

export const SEED_PATIENTS = [
  {
    first_name: "Jane", last_name: "Doe", date_of_birth: "03/14/1985", sex: "Female", phone_number: "2125550147",
    email: "jane.doe@example.com", address_line_1: "123 Main Street", address_line_2: "Apt 4B", city: "New York",
    state: "NY", zip_code: "10001", insurance_provider: "Aetna", insurance_member_id: "AET123456789",
    preferred_language: "English", emergency_contact_name: "John Doe", emergency_contact_phone: "2125550148",
  },
  {
    first_name: "Carlos", last_name: "Rivera", date_of_birth: "11/02/1972", sex: "Male", phone_number: "3055550199",
    address_line_1: "450 Ocean Drive", city: "Miami", state: "FL", zip_code: "33139", preferred_language: "Spanish",
  },
];

export async function seedIfEmpty(ctx: MutationCtx) {
  if (await ctx.db.query("patients").first()) return { inserted: 0 };
  for (const record of SEED_PATIENTS) await createPatient(ctx, validatePatient(record, "create"));
  console.log(`seed.inserted count=${SEED_PATIENTS.length}`);
  return { inserted: SEED_PATIENTS.length };
}
