/**
 * Idempotently create/update the Vapi assistant and attach a free U.S. Vapi phone number.
 *   VAPI_API_KEY=... PUBLIC_BASE_URL=https://<deployment>.convex.site VAPI_WEBHOOK_SECRET=... \
 *     bun voice-agent/provision.ts [--area-code 415]
 */
import { buildAssistant } from "./assistantConfig";

const { VAPI_API_KEY: KEY, PUBLIC_BASE_URL: BASE, VAPI_WEBHOOK_SECRET: SECRET } = process.env;
const CLINIC = process.env.CLINIC_NAME ?? "CareCloud Family Medicine";
if (!KEY || !BASE) throw new Error("Set VAPI_API_KEY and PUBLIC_BASE_URL");
const areaIdx = process.argv.indexOf("--area-code");
const areaCode = areaIdx > 0 ? process.argv[areaIdx + 1] : "415"; // Vapi requires a desired area code

async function vapi(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const config = buildAssistant(BASE, SECRET, CLINIC);
const existing = ((await vapi("GET", "/assistant?limit=100")) as any[]).find((a) => a.name === config.name);
const assistant = existing ? await vapi("PATCH", `/assistant/${existing.id}`, config) : await vapi("POST", "/assistant", config);
console.log(`assistant ${existing ? "updated" : "created"}: ${assistant.id}`);

const numbers = (await vapi("GET", "/phone-number")) as any[];
let number = numbers.find((n) => n.assistantId === assistant.id) ?? numbers.find((n) => !n.assistantId);
if (number) {
  number = await vapi("PATCH", `/phone-number/${number.id}`, { assistantId: assistant.id });
} else {
  number = await vapi("POST", "/phone-number", {
    provider: "vapi", name: "Patient intake line", assistantId: assistant.id, numberDesiredAreaCode: areaCode,
  });
}
console.log(`phone number: ${number.number ?? "(provisioning…)"} id=${number.id} status=${number.status ?? ""}`);
