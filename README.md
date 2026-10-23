# Voice AI Agent — Patient Registration

A phone-based AI agent ("Ava") that registers new patients for a medical clinic in a natural conversation,
validates every field, reads everything back for confirmation, and saves the record to a persistent database
exposed through a REST API. Built for the CareCloud AI Engineer take-home.

| | |
|---|---|
| **Call the agent** | **+1 (323) 306-8029** |
| **REST API base URL** | `https://clever-pelican-734.convex.site` |
| **Live dashboard** | https://carecloud-intake-ai-offers.viktor.space |
| **Health check** | `GET https://clever-pelican-734.convex.site/health` |

No credentials are needed: the API is open for review (see Limitations). Two demo patients are seeded:
**Jane Doe** (phone 212-555-0147, DOB 03/14/1985) and **Carlos Rivera** (305-555-0199, Spanish speaker).
Give Jane's phone number during a call to see duplicate detection.

---

## Architecture

```
 Caller ──PSTN──▶ Vapi (US number · Deepgram nova-3 STT · GPT-4o · ElevenLabs TTS)
                        │  tool calls / end-of-call report (HTTPS webhook, shared-secret header)
                        ▼
              Convex HTTP router  (convex/http.ts)
          ┌─────────────┴──────────────┐
   /vapi/webhook                 /patients, /calls, /health      ◀── REST clients
   convex/agent.ts (tools)       convex/restApi.ts (envelope, status codes)
          └─────────────┬──────────────┘
                 service layer: convex/patients.ts · calls.ts · appointments.ts
                 validation:    convex/validation.ts   (ONE set of rules for both channels)
                        ▼
              Convex database (persistent, transactional)  ──live query──▶ React dashboard (src/)
```

**Key design decisions**

- **One validation + persistence path.** The voice agent never writes to the DB directly; its tools call the same
  service layer and validators as `POST /patients`. A record created by phone is indistinguishable from one created
  via the API, and rules can't drift between channels.
- **The LLM validates conversationally, the server validates authoritatively.** The prompt tells Ava the rules so she
  can re-prompt instantly ("I heard 8 digits, could you repeat your phone number?"). The server re-checks everything
  and returns field-level errors; the tool result tells Ava to re-ask for *only* the failing field.
- **Tool results carry an `instruction`.** Every tool response (success, validation error, duplicate, system error)
  tells the model what to say next, so the caller never hears silence or a false "you're saved". A database failure
  rolls back the mutation and Ava says honestly that nothing was saved.
- **Confirmation before save.** The prompt makes the read-back mandatory; `register_patient` is described as
  "only after the caller confirmed".
- **Transactional writes.** Each request or tool call is a single Convex mutation, so it applies fully or not at all.
- **Infrastructure as code for the agent.** The full Vapi assistant (prompt, voice, transcriber, tools, webhook) is
  defined in `voice-agent/assistantConfig.ts`, and `bun run provision:vapi` creates or updates it idempotently.

### Stack and why

| Layer | Choice | Why |
|---|---|---|
| Telephony + STT/TTS orchestration | **Vapi** | Real US number in minutes, low-latency turn-taking, barge-in, function calling, end-of-call transcripts. |
| LLM | **OpenAI GPT-4o** (temp 0.3) | Reliable tool calling and instruction following; low temperature for accurate data capture. |
| Speech | **Deepgram nova-3 (multi)** + **ElevenLabs turbo v2.5** | Fast, accurate on names and digits; both multilingual, so the Spanish switch works mid-call. |
| Backend + DB | **Convex** (TypeScript) | Persistent, ACID document DB with HTTP actions on one always-on deployment, so there are no cold starts mid-call. Live queries power the dashboard with no extra code. |
| Dashboard | React 19 + Vite + Tailwind | Real-time view of patients and call transcripts. |

---

## REST API

All responses use the envelope `{"data": ..., "error": null}` or `{"data": null, "error": {"code", "message", "details?"}}`.

| Method | Path | Description |
|---|---|---|
| GET | `/patients` | List active patients. Filters: `last_name` (case-insensitive), `date_of_birth` (MM/DD/YYYY or YYYY-MM-DD), `phone_number` (any format). Paging: `limit` (1–500, default 100), `offset`. |
| GET | `/patients/:id` | Get one patient by UUID. |
| POST | `/patients` | Create a patient. Validates all fields server-side. Returns 201. |
| PUT | `/patients/:id` | Partial update: only the fields sent change. Required fields can't be cleared; optional fields clear with `null`. |
| DELETE | `/patients/:id` | Soft delete (sets `deleted_at`). The patient disappears from GET. |
| GET | `/patients/:id/calls` | Bonus: call log and transcripts linked to the patient. |
| GET | `/patients/:id/appointments` | Bonus: booked appointments. |
| GET | `/calls` | Bonus: recent calls (outcome `registered` / `updated` / `incomplete`). |
| GET | `/health` | Liveness and DB check. |
| POST | `/vapi/webhook` | Vapi server URL (tool calls, status updates, end-of-call reports). Requires the `x-vapi-secret` header. |

Status codes: `200` OK · `201` created · `400` malformed JSON, non-object body, bad UUID or bad query param ·
`404` not found or soft-deleted · `422` field validation failed (with per-field `details`) · `500` unexpected error.

```bash
B=https://clever-pelican-734.convex.site
curl "$B/patients?last_name=doe"
curl -X POST $B/patients -H 'content-type: application/json' -d '{
  "first_name":"John","last_name":"Smith","date_of_birth":"05/02/1990","sex":"Male",
  "phone_number":"(415) 555-0123","address_line_1":"1 Market St","city":"San Francisco",
  "state":"CA","zip_code":"94105"}'
```

### Data model and validation

Patient fields follow the spec: `patient_id` (UUID), first/last name, `date_of_birth`, `sex`, `phone_number`, `email`,
`address_line_1/2`, `city`, `state`, `zip_code`, insurance provider and member ID, `preferred_language` (default English),
emergency contact name and phone, plus `created_at`, `updated_at` and `deleted_at`.

- Names: 1–50 letters, hyphens, apostrophes (accented letters allowed).
- DOB: a real calendar date, not in the future, not more than 130 years ago. Returned as MM/DD/YYYY.
- Phone: normalized to 10 digits. Accepts `(555) 123-4567`, `+1 555…`. Area code can't start with 0/1.
- State: 2-letter USPS code (full names like "California" are normalized). ZIP: 5 digits or ZIP+4.
- Sex: Male / Female / Other / Decline to Answer (natural answers like "woman" are mapped).
- Email format, alphanumeric member ID, control-character stripping and whitespace collapsing on all text.
- Unknown fields are rejected (422).

---

## Voice agent behavior

- Opens warmly, asks one thing at a time, and accepts out-of-order answers ("I'm John Smith, born May 2nd 1990").
- Handles corrections at any point, spelling, interruptions (barge-in), "start over", and questions it can't answer.
- Re-prompts for the specific invalid field (impossible date, wrong digit count, future DOB…).
- Offers the optional bundle (insurance, emergency contact, language) once.
- **Reads back all collected information and waits for a clear "yes" before saving.**
- After the save: "You're all set, [First Name]." Then it offers a first appointment and ends the call gracefully.
- The structured payload is logged before every save (`agent.final_payload …`), and each transcript is logged at the end of the call.

**Bonus features implemented**
- **Duplicate detection:** looks up the caller's phone number. "It looks like we already have a record for Jane Doe.
  Would you like to update your information instead?" The update requires the caller to confirm their DOB.
- **Appointment scheduling (mock):** offers the next business-day slots and books one, with double-booking prevented.
- **Spanish:** switches language mid-call and stores `preferred_language = Spanish`.
- **Call transcripts and summaries:** stored per call and linked to the patient. Dropped calls are kept as `incomplete` for follow-up.
- **Dashboard:** live patients table and call transcripts.
- **Tests:** unit tests for the validators, and an end-to-end suite covering the REST API and simulated Vapi webhook traffic.

---

## Running it yourself

Requirements: [Bun](https://bun.sh) ≥ 1.1 (or Node 22), a free [Convex](https://convex.dev) account, and a [Vapi](https://vapi.ai) account.

```bash
bun install
bunx convex dev --once          # creates your Convex deployment and pushes the schema and functions
bunx convex run restApi:seed    # optional demo patients
bunx convex env set VAPI_WEBHOOK_SECRET "$(openssl rand -hex 24)"
bun run build && bun run preview   # dashboard on http://localhost:4173

# Voice agent: creates or updates the assistant and attaches a free US Vapi number
VAPI_API_KEY=... PUBLIC_BASE_URL=https://<your-deployment>.convex.site VAPI_WEBHOOK_SECRET=... \
  bun run provision:vapi --area-code 323
```

### Environment variables

| Name | Where | Purpose |
|---|---|---|
| `VAPI_WEBHOOK_SECRET` | Convex deployment env | Shared secret Vapi sends in `x-vapi-secret`. The webhook rejects calls without it. |
| `VAPI_API_KEY` | Shell, provisioning only | Vapi private key, used by `voice-agent/provision.ts`. Never committed. |
| `PUBLIC_BASE_URL` | Shell, provisioning only | The deployment's `.convex.site` URL that Vapi calls. |
| `CLINIC_NAME` | Shell, optional | Clinic name used in the greeting (default "CareCloud Family Medicine"). |
| `VITE_CONVEX_URL` | `.env.local` (written by `convex dev`) | Dashboard → Convex connection. |

### Tests

```bash
bun run test:validation                                    # unit tests (validators)
API_BASE_URL=https://<deployment>.convex.site VAPI_WEBHOOK_SECRET=... bun run test:api
```

The e2e suite covers create → get → filter → update → soft delete, every error status, a wrong webhook secret, and a
full simulated call: lookup, invalid DOB re-prompt, registration, duplicate detection, update, slot booking with
double-booking prevention, transcript storage, and a dropped call.

### Where the solution lives

`convex/validation.ts`, `patients.ts`, `calls.ts`, `appointments.ts`, `restApi.ts`, `agent.ts`, `http.ts`, `schema.ts`,
`seed.ts`, `dashboard.ts` · `voice-agent/` (prompt, assistant config, provisioning) · `src/pages/PublicLandingPage.tsx`
(dashboard) · `tests/`. The remaining files (auth, UI primitives, build scripts) are the starter template the
dashboard is hosted on. `docs/TEMPLATE_GUIDE.md` describes them.

---

## Known limitations and next steps

- **No API authentication**, so the reviewers can test freely. Production would add API keys or OAuth plus RBAC, and the
  dashboard would sit behind staff login. The demo data is fictitious, but real PHI needs a HIPAA BAA with every vendor
  (Vapi, OpenAI, Deepgram, ElevenLabs, DB host), PHI redaction in logs, and audit trails.
- Phone numbers aren't unique (families share phones). Duplicates are detected and confirmed by voice instead of being blocked by a constraint.
- Identity verification for updates is DOB-only. A real system would add a second factor.
- Appointment slots are mocked (no EHR or calendar integration). Times are in America/New_York.
- Spoken email addresses are inherently error-prone, so the agent spells them back character by character.
- Free-tier Vapi credits and number: if the line stops answering, the credits ran out (redeploy with `provision:vapi`).
