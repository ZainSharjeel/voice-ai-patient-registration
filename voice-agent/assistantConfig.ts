/**
 * The Vapi assistant definition (telephony + STT + LLM + TTS + tools) as code, so the whole voice
 * agent is version-controlled and reproducible via `bun voice-agent/provision.ts`.
 */
import { buildSystemPrompt, END_CALL_MESSAGE, FIRST_MESSAGE } from "./prompt";

const PATIENT_PROPS = {
  first_name: { type: "string", description: "Letters, hyphens, apostrophes." },
  last_name: { type: "string", description: "Exact spelling confirmed with caller." },
  date_of_birth: { type: "string", description: "MM/DD/YYYY" },
  sex: { type: "string", enum: ["Male", "Female", "Other", "Decline to Answer"] },
  phone_number: { type: "string", description: "10-digit U.S. number, digits only" },
  email: { type: "string" },
  address_line_1: { type: "string", description: "Street address" },
  address_line_2: { type: "string", description: "Apt/Suite/Unit" },
  city: { type: "string" },
  state: { type: "string", description: "2-letter U.S. state abbreviation" },
  zip_code: { type: "string", description: "12345 or 12345-6789" },
  insurance_provider: { type: "string" },
  insurance_member_id: { type: "string", description: "Alphanumeric" },
  preferred_language: { type: "string", description: "Default English" },
  emergency_contact_name: { type: "string" },
  emergency_contact_phone: { type: "string", description: "10-digit U.S. number" },
};
const REQUIRED = ["first_name", "last_name", "date_of_birth", "sex", "phone_number", "address_line_1", "city", "state", "zip_code"];

export function buildAssistant(baseUrl: string, webhookSecret: string | undefined, clinicName: string) {
  const server: Record<string, unknown> = { url: `${baseUrl.replace(/\/$/, "")}/vapi/webhook`, timeoutSeconds: 20 };
  if (webhookSecret) server.headers = { "x-vapi-secret": webhookSecret };
  const tool = (name: string, description: string, properties: object, required: string[]) => ({
    type: "function", async: false, server,
    function: { name, description, parameters: { type: "object", properties, required } },
  });

  return {
    name: "CareCloud Patient Intake",
    firstMessage: FIRST_MESSAGE(clinicName),
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.3, // low: consistent, accurate data capture; still natural phrasing
      messages: [{ role: "system", content: buildSystemPrompt(clinicName) }],
      tools: [
        tool("find_patient_by_phone", "Look up an existing patient by phone number (duplicate detection).",
          { phone_number: PATIENT_PROPS.phone_number }, ["phone_number"]),
        tool("register_patient", "Save a NEW patient. Only call after reading back all info and the caller confirmed it.",
          { ...PATIENT_PROPS, allow_duplicate_phone: { type: "boolean",
            description: "True only if caller confirmed they are a different person from the existing record with this phone." } },
          REQUIRED),
        tool("update_patient", "Update an existing patient's fields (only changed fields) after the caller verified their date of birth and confirmed the changes.",
          { patient_id: { type: "string" }, ...PATIENT_PROPS }, ["patient_id"]),
        tool("get_appointment_slots", "Get available first-appointment slots.", {}, []),
        tool("book_appointment", "Book a first appointment for a registered patient.",
          { patient_id: { type: "string" }, slot_start: { type: "string" }, reason: { type: "string" } }, ["patient_id", "slot_start"]),
        { type: "endCall" },
      ],
    },
    // Multilingual voice + transcriber so the bonus Spanish switch works mid-call.
    voice: { provider: "11labs", voiceId: "21m00Tcm4TlvDq8ikWAM", model: "eleven_turbo_v2_5", stability: 0.5, similarityBoost: 0.75 },
    transcriber: { provider: "deepgram", model: "nova-3", language: "multi" },
    endCallMessage: END_CALL_MESSAGE,
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    backgroundDenoisingEnabled: true,
    server,
    serverMessages: ["end-of-call-report", "status-update"],
  };
}
