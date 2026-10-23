"""Builds the Vapi assistant definition (telephony + STT + LLM + TTS + tools) as code, so the whole
voice agent is version-controlled and reproducible via scripts/provision_vapi.py."""
from __future__ import annotations

from app.agent.prompt import END_CALL_MESSAGE, FIRST_MESSAGE, build_system_prompt

_PATIENT_PROPS = {
    "first_name": {"type": "string", "description": "Letters, hyphens, apostrophes."},
    "last_name": {"type": "string", "description": "Exact spelling confirmed with caller."},
    "date_of_birth": {"type": "string", "description": "MM/DD/YYYY"},
    "sex": {"type": "string", "enum": ["Male", "Female", "Other", "Decline to Answer"]},
    "phone_number": {"type": "string", "description": "10-digit U.S. number, digits only"},
    "email": {"type": "string"},
    "address_line_1": {"type": "string", "description": "Street address"},
    "address_line_2": {"type": "string", "description": "Apt/Suite/Unit"},
    "city": {"type": "string"},
    "state": {"type": "string", "description": "2-letter U.S. state abbreviation"},
    "zip_code": {"type": "string", "description": "12345 or 12345-6789"},
    "insurance_provider": {"type": "string"},
    "insurance_member_id": {"type": "string", "description": "Alphanumeric"},
    "preferred_language": {"type": "string", "description": "Default English"},
    "emergency_contact_name": {"type": "string"},
    "emergency_contact_phone": {"type": "string", "description": "10-digit U.S. number"},
}
_REQUIRED = ["first_name", "last_name", "date_of_birth", "sex", "phone_number",
             "address_line_1", "city", "state", "zip_code"]


def _tool(name: str, description: str, properties: dict, required: list[str], server: dict) -> dict:
    return {
        "type": "function",
        "async": False,
        "function": {"name": name, "description": description,
                     "parameters": {"type": "object", "properties": properties, "required": required}},
        "server": server,
    }


def build_assistant(base_url: str, webhook_secret: str | None, clinic_name: str) -> dict:
    server = {"url": f"{base_url.rstrip('/')}/vapi/webhook", "timeoutSeconds": 20}
    if webhook_secret:
        server["headers"] = {"x-vapi-secret": webhook_secret}

    tools = [
        _tool("find_patient_by_phone", "Look up an existing patient by phone number (duplicate detection).",
              {"phone_number": _PATIENT_PROPS["phone_number"]}, ["phone_number"], server),
        _tool("register_patient",
              "Save a NEW patient. Only call after reading back all info and the caller confirmed it.",
              {**_PATIENT_PROPS, "allow_duplicate_phone": {
                  "type": "boolean", "description": "True only if caller confirmed they are a different "
                                                     "person from the existing record with this phone."}},
              _REQUIRED, server),
        _tool("update_patient", "Update an existing patient's fields (only changed fields) after the caller "
              "verified their date of birth and confirmed the changes.",
              {"patient_id": {"type": "string"}, **_PATIENT_PROPS}, ["patient_id"], server),
        _tool("get_appointment_slots", "Get available first-appointment slots.", {}, [], server),
        _tool("book_appointment", "Book a first appointment for a registered patient.",
              {"patient_id": {"type": "string"}, "slot_start": {"type": "string"},
               "reason": {"type": "string"}}, ["patient_id", "slot_start"], server),
    ]

    return {
        "name": "CareCloud Patient Intake",
        "firstMessage": FIRST_MESSAGE.format(clinic_name=clinic_name),
        "firstMessageMode": "assistant-speaks-first",
        "model": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.3,  # low: consistent, accurate data capture; still natural phrasing
            "messages": [{"role": "system", "content": build_system_prompt(clinic_name)}],
            "tools": tools + [{"type": "endCall"}],
        },
        # Multilingual voice + transcriber so the bonus Spanish switch works mid-call.
        "voice": {"provider": "11labs", "voiceId": "21m00Tcm4TlvDq8ikWAM", "model": "eleven_turbo_v2_5",
                  "stability": 0.5, "similarityBoost": 0.75},
        "transcriber": {"provider": "deepgram", "model": "nova-3", "language": "multi"},
        "endCallMessage": END_CALL_MESSAGE,
        "silenceTimeoutSeconds": 30,
        "maxDurationSeconds": 900,
        "backgroundDenoisingEnabled": True,
        "server": server,
        "serverMessages": ["end-of-call-report", "status-update"],
    }
