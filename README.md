# Voice AI Agent — Patient Registration

Call a real U.S. phone number, talk to **Ava**, a voice agent that handles patient intake. She collects standard U.S. patient demographics in a natural conversation, reads everything back for confirmation and saves the record to PostgreSQL. You can then see the record through a REST API and a live dashboard.

| | |
|---|---|
| 📞 **Phone number** | `{{PHONE_NUMBER}}` |
| 🌐 **API base URL** | `{{BASE_URL}}` |
| 📊 **Dashboard** | `{{BASE_URL}}/dashboard` |
| 📘 **Interactive API docs (OpenAPI)** | `{{BASE_URL}}/docs` |

No credentials are needed for testing. The API and dashboard are open on purpose so reviewers can get in easily; see *Limitations*.

---

## Architecture

```
 ┌──────────┐   PSTN    ┌──────────────────────────── Vapi ───────────────────────────┐
 │  Caller  │ ────────▶ │  Phone number → Deepgram STT → GPT-4o (prompt + tools) → TTS │
 └──────────┘           └───────────────────────────────┬──────────────────────────────┘
                                                        │ HTTPS webhook (tool calls,
                                                        │ end-of-call report) + shared secret
                                ┌───────────────────────▼───────────────────────┐
                                │ FastAPI service                               │
                                │  app/api/vapi.py      ← Vapi adapter (only    │
                                │                         vendor-specific code) │
                                │  app/agent/tools.py   ← provider-agnostic     │
                                │                         tool logic            │
                                │  app/api/patients.py  ← REST API              │
                                │  app/services/*       ← business logic (one   │
                                │                         path for API + agent) │
                                │  app/schemas.py +                             │
                                │  app/validation.py    ← server-side validation│
                                │  app/models.py        ← SQLAlchemy schema     │
                                └───────────────────────┬───────────────────────┘
                                                        │
                                              ┌─────────▼─────────┐
                                              │ PostgreSQL        │  patients, call_logs,
                                              │ (Railway)         │  appointments
                                              └───────────────────┘
```

**Separation of concerns**
- **Telephony / speech** (Vapi): the phone number, speech-to-text, text-to-speech, barge-in and turn-taking.
- **Conversation logic**: the LLM system prompt (`app/agent/prompt.py`) plus tool definitions (`app/agent/assistant_config.py`). The full assistant is defined in code and provisioned by `scripts/provision_vapi.py`, so it's version-controlled and reproducible.
- **Tools** (`app/agent/tools.py`): plain Python functions that take dicts and return dicts. They don't depend on Vapi, so moving to Retell or Twilio would only mean writing a new adapter.
- **Data layer**: the voice tools and the REST API call **the same service layer and the same validators**, so a record created by phone and one created through `POST /patients` go through identical rules.

**Call flow**
1. Ava greets the caller and collects the required fields. She accepts answers given out of order, handles corrections and supports "start over".
2. As soon as she has the phone number she calls `find_patient_by_phone`. If it matches an existing record, she says *"It looks like we already have a record for Jane Doe. Would you like to update your information instead?"* (bonus: duplicate detection). Before changing anything she verifies the caller's DOB.
3. She offers the optional bundle once (insurance, emergency contact, preferred language).
4. She reads back **all** fields, spelling the last name letter by letter, and waits for an explicit "yes".
5. She calls `register_patient`. The server validates again, writes to Postgres and logs the final payload. If any field is invalid, she gets per-field errors and re-asks for **only those fields**. If the database fails, she gets a `system_error` and tells the caller honestly that nothing was saved, so there's never silence or a false "success".
6. She says "You're all set, [First Name]." and offers to book a first appointment (bonus, mock slots). Then she says goodbye and ends the call.
7. Vapi sends an end-of-call report. The transcript and summary are stored in `call_logs` and linked to the patient (bonus). A call that drops before saving is stored with `outcome=incomplete` and its partial transcript, so staff can follow up.

## Tech stack & why

| Layer | Choice | Why |
|---|---|---|
| Telephony + STT/TTS | **Vapi** (free U.S. number) | Takes care of the PSTN, streaming STT/TTS, interruptions and endpointing, so the time goes into the prompt, the tools and the backend (as the brief recommends). |
| STT | Deepgram **nova-3, `multi`** | Low latency, and handles English/Spanish code-switching (bonus: multi-language). |
| LLM | OpenAI **GPT-4o**, temperature 0.3 | Reliable tool-calling and good at handling corrections. Low temperature keeps data capture consistent. |
| TTS | ElevenLabs **turbo v2.5** | Natural voice with low latency; multilingual, so it can speak Spanish. |
| Backend | **Python 3.12 + FastAPI** | Typed, fast to build, automatic OpenAPI docs at `/docs`. |
| Validation | **Pydantic v2** + pure validators | One set of rules, reused by both the API and the agent. |
| DB | **PostgreSQL** (SQLAlchemy 2.0) | Relational data with real constraints. SQLite is used automatically for local dev and tests. |
| Hosting | **Railway** (Docker) | Always-on (no cold start in the middle of a call), managed Postgres, deploys straight from the repo. |

## Data model

`patients`: every field from the brief, with real column types (`UUID`, `DATE`, `TIMESTAMPTZ`, sized `VARCHAR`s), a `sex` enum enforced by a CHECK constraint, CHECK constraints on phone, state, ZIP and name lengths, and indexes on `phone_number`, `last_name` and `date_of_birth` (the API's filter fields). `created_at` and `updated_at` are set automatically in UTC. `deleted_at` handles soft deletes.

Validation rules (`app/validation.py`):
- **Names**: 1–50 letters (accented letters allowed), hyphens and apostrophes. Single internal spaces are also allowed (e.g. "De La Cruz"); see trade-offs.
- **DOB**: must be a real calendar date, can't be in the future, can't be more than 130 years ago. Accepts `MM/DD/YYYY` (also `YYYY-MM-DD`) and is always returned as `MM/DD/YYYY`.
- **Phone**: must be 10 digits after removing formatting and a leading `+1`. The area code can't start with 0 or 1.
- **State**: valid USPS code, including DC and territories. Full names are mapped to codes ("California" → `CA`).
- **ZIP**: `12345` or `12345-6789` (9 bare digits are reformatted).
- **Email**: RFC syntax check. **Member ID**: alphanumeric, uppercased.
- **Sanitization**: control characters are stripped, whitespace is collapsed, and unknown fields are rejected (`extra=forbid`).

Other tables: `call_logs` (transcript, summary, outcome, ended reason, linked `patient_id`) and `appointments` (mock scheduling).

## REST API

All responses use the envelope `{"data": ..., "error": null}`. On error: `{"data": null, "error": {"code", "message", "details": [{"field","message"}]}}`.

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/patients` | Filters: `?last_name=` (case-insensitive), `?date_of_birth=` (MM/DD/YYYY), `?phone_number=` (any format). Also supports `limit`/`offset`. |
| GET | `/patients/{id}` | 404 if missing or soft-deleted, 400 if the UUID is malformed |
| POST | `/patients` | 201 + created record with `patient_id`, 422 with per-field errors |
| PUT | `/patients/{id}` | Partial update. Required fields can't be cleared. |
| DELETE | `/patients/{id}` | Soft delete (sets `deleted_at`; the record disappears from GET) |
| GET | `/patients/{id}/calls` | Call transcripts linked to the patient (bonus) |
| GET | `/patients/{id}/appointments` | Booked appointments (bonus) |
| GET | `/calls` | All call logs, including incomplete or dropped calls |
| GET | `/health` | Liveness check plus DB connectivity |
| POST | `/vapi/webhook` | Vapi tool calls and end-of-call reports. Requires the `x-vapi-secret` header. |

Status codes: 200, 201, 400 (malformed JSON, body or UUID), 401 (webhook secret), 404, 422 (validation), 500 (unexpected error, logged with a stack trace).

```bash
curl -s {{BASE_URL}}/patients?last_name=doe
curl -s -X POST {{BASE_URL}}/patients -H 'content-type: application/json' -d '{
  "first_name":"Ana","last_name":"Lopez","date_of_birth":"07/04/1990","sex":"Female",
  "phone_number":"(415) 555-0123","address_line_1":"1 Market St","city":"San Francisco",
  "state":"CA","zip_code":"94105"}'
```

## Prompt engineering

The full system prompt is in **`app/agent/prompt.py`**. It's split into commented sections: identity and tone, fields, conversational robustness, validation and tool usage. Python comments explain each design decision and are not sent to the model. Key choices:
- **Written for voice**: one question per turn, no lists or markdown (TTS would read the symbols), phone numbers spoken digit by digit, varied acknowledgements so she doesn't sound robotic.
- **Today's date injected at call time** (Vapi Liquid `{{"now" | date ...}}`) so the model can reject future DOBs.
- **Explicit rules** for corrections, out-of-order answers, interruptions, start-over and switching to Spanish.
- **Mandatory read-back before saving**, with letter-by-letter spelling of the last name.
- **Tool results include an `instruction`** that tells the model what to say next. This keeps failure handling (validation errors, DB down, duplicates) deterministic and keeps it from claiming success it didn't get.
- **Defense in depth**: the agent validates during the conversation (fast re-prompts), and the server re-validates everything.

## Edge cases & resilience

| Scenario | Behaviour |
|---|---|
| Invalid DOB / 3-digit phone / bad ZIP | The prompt makes her re-ask for that one field. If a bad value still gets through, the server returns `invalid_fields` and she re-asks only for those. |
| Corrections ("it's D-A-V-I-S") | Replaces the value, confirms it, and moves on. The final read-back catches anything left over. |
| Caller wants to start over | Discards collected data and starts again from the name. |
| DB write fails | The tool returns `system_error`, and Ava says the record was **not** saved and offers to retry. The error is logged with a stack trace. |
| Call drops mid-conversation | Nothing half-saved: records are only written after confirmation. The end-of-call report stores the partial transcript as an `incomplete` call. |
| Returning caller | Detected by phone number. She offers to update, verifies DOB, and updates only the changed fields. |
| Family members sharing a phone | Ava can register a new person on the same phone after the caller confirms (`allow_duplicate_phone`). |
| Webhook spoofing | Shared-secret header, compared in constant time. |

## Observability

Structured log lines go to stdout (view them in Railway → Deployments → Logs):
`agent.tool_call`, `agent.final_payload` (the full collected JSON for every registration), `patient.created/updated/soft_deleted`, `vapi.status`, and `vapi.end_of_call` with the full transcript. Transcripts and summaries are also saved in the DB and shown on the dashboard.

## Bonus features

- ✅ Duplicate detection plus an update flow
- ✅ Appointment scheduling (mock slots, next 3 business days)
- ✅ Spanish support (multilingual STT/TTS, plus a prompt rule)
- ✅ Call transcripts and summaries linked to patients
- ✅ Dashboard at `/dashboard`
- ✅ Automated tests: 29 pytest tests covering the API, validators and voice-agent webhook (including the DB-failure path and dropped calls)

## Local setup

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env           # optional; defaults to SQLite at ./data/patients.db
uvicorn app.main:app --reload  # http://localhost:8000/dashboard , /docs
pytest -q                      # run the test suite
```

To try the voice agent against a local server, expose it (`ngrok http 8000`), then run `PUBLIC_BASE_URL=https://<ngrok-url> VAPI_API_KEY=... python scripts/provision_vapi.py`.

### Deploy (Railway)
1. Create a project, add a **PostgreSQL** database, and add this repo as a service (it builds from the `Dockerfile`; health check is `/health`).
2. Set the service variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `VAPI_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`.
3. Run `scripts/provision_vapi.py` once to create the assistant and attach a phone number.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | prod | Postgres connection string (falls back to SQLite) |
| `VAPI_WEBHOOK_SECRET` | recommended | Shared secret checked on `/vapi/webhook` |
| `PUBLIC_BASE_URL` | provisioning | Public URL that Vapi tools call |
| `VAPI_API_KEY` | provisioning only | Used by `scripts/provision_vapi.py`; never needed by the server |
| `CLINIC_NAME`, `CLINIC_TIMEZONE` | no | Greeting and appointment timezone |
| `SEED_DEMO_DATA` | no | Seeds Jane Doe and Carlos Rivera on an empty DB (default `true`) |
| `LOG_LEVEL` | no | Default `INFO` |

## Known limitations & trade-offs

- **No auth on the REST API or dashboard**, to make review easy. In production I'd add API keys or OAuth and role-based access, encryption at rest and audit logging (HIPAA). The data here is demo data only.
- **Duplicate detection reveals the name on file** to anyone who calls with a matching phone number, as the brief specifies. DOB verification is required before any update.
- **Names may contain internal spaces** ("Mary Ann", "De La Cruz"). This is a little looser than "alphabetic + hyphens/apostrophes" because rejecting real names on a live call is worse UX.
- **Phone numbers are not unique**, because families often share a number. Duplicates are handled conversationally instead.
- **Tables are created on startup** (`create_all`) rather than through Alembic migrations, to fit the time limit.
- **Appointment slots are generated mock data**, not a real calendar.
- **Transcripts depend on Vapi's end-of-call webhook.** If our server were down at that moment the transcript would be lost; the patient record would not be affected.
- **Speech recognition of spelled names and emails** depends on STT quality, which is why the read-back step is mandatory.

## Next steps

Alembic migrations, API authentication, retry/queue for DB writes during an outage (e.g. buffer to Redis and confirm by SMS), SMS confirmation of the appointment, an evaluation suite of simulated callers (Vapi test suites) running in CI, PHI encryption, and HIPAA-eligible vendors (BAA).
