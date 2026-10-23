"""Voice-agent tool implementations (provider-agnostic).

Each tool takes plain dict arguments from the LLM and returns a dict that is serialized back to the
LLM. Results always include an `instruction` hint so the agent knows what to say next — including on
failure, so the caller never hears silence. Tools call the service layer directly (same validation +
persistence code path as POST /patients).
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Callable

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.schemas import PatientCreate, PatientOut, PatientUpdate
from app.services import appointments as appt_service
from app.services import calls as call_service
from app.services import patients as patient_service

log = logging.getLogger("agent.tools")

SYSTEM_ERROR = {
    "success": False,
    "error": "system_error",
    "instruction": ("Apologize briefly: tell the caller you hit a technical problem saving their "
                    "information, so it was NOT saved. Offer to try once more, or suggest they call back "
                    "a little later. Do not pretend it succeeded."),
}


def _field_errors(exc: ValidationError) -> list[dict]:
    errors = []
    for e in exc.errors():
        field = ".".join(str(p) for p in e.get("loc", [])) or "record"
        errors.append({"field": field, "message": e.get("msg", "").removeprefix("Value error, ")})
    return errors


def _invalid(exc: ValidationError) -> dict:
    errors = _field_errors(exc)
    return {
        "success": False,
        "error": "validation_failed",
        "invalid_fields": errors,
        "instruction": ("Nothing was saved. Tell the caller which specific item needs fixing (in plain "
                        "words, one at a time), ask again for ONLY that item, then call the tool again "
                        "with the corrected value."),
    }


def _patient_args(args: dict) -> dict:
    allowed = PatientCreate.model_fields.keys()
    return {k: v for k, v in args.items() if k in allowed and v not in (None, "")}


def find_patient_by_phone(db: Session, args: dict, ctx: dict) -> dict:
    from app.validation import validate_us_phone
    try:
        phone = validate_us_phone(args.get("phone_number", ""))
    except ValueError as exc:
        return {"success": False, "error": "invalid_phone", "message": str(exc),
                "instruction": "Ask the caller to repeat their 10-digit phone number."}
    matches = patient_service.find_by_phone(db, phone)
    if not matches:
        return {"success": True, "found": False, "instruction": "No existing record. Continue registration."}
    p = matches[0]
    return {
        "success": True, "found": True,
        "patient": {"patient_id": str(p.patient_id), "first_name": p.first_name, "last_name": p.last_name,
                    "date_of_birth": p.date_of_birth.strftime("%m/%d/%Y")},
        "instruction": (f"Say: 'It looks like we already have a record for {p.first_name} {p.last_name}. "
                        "Would you like to update your information instead?' If yes, verify identity by "
                        "asking for their date of birth (must match) before changing anything, then use "
                        "update_patient. If it's a different person (e.g. a family member sharing the "
                        "phone), continue a new registration and pass allow_duplicate_phone=true."),
    }


def register_patient(db: Session, args: dict, ctx: dict) -> dict:
    allow_dup = bool(args.get("allow_duplicate_phone"))
    try:
        data = PatientCreate.model_validate(_patient_args(args))
    except ValidationError as exc:
        return _invalid(exc)

    if not allow_dup:
        existing = patient_service.find_by_phone(db, data.phone_number)
        if existing:
            p = existing[0]
            return {
                "success": False, "error": "possible_duplicate",
                "existing_patient": {"patient_id": str(p.patient_id), "first_name": p.first_name,
                                     "last_name": p.last_name},
                "instruction": (f"Nothing saved yet. Say: 'It looks like we already have a record for "
                                f"{p.first_name} {p.last_name}. Would you like to update your information "
                                "instead?' Update -> update_patient. New person -> call register_patient "
                                "again with allow_duplicate_phone=true."),
            }

    log.info("agent.final_payload call_id=%s payload=%s", ctx.get("call_id"),
             json.dumps(data.model_dump(mode="json")))
    try:
        patient = patient_service.create_patient(db, data)
    except Exception:
        log.exception("agent.register_failed call_id=%s", ctx.get("call_id"))
        return SYSTEM_ERROR
    call_service.link_patient(db, ctx.get("call_id"), patient.patient_id, "registered", ctx.get("caller_number"))
    return {
        "success": True, "patient_id": str(patient.patient_id),
        "instruction": (f"Saved. Tell the caller 'You're all set, {patient.first_name}.' Then offer to "
                        "schedule a first appointment. If they decline, say a warm goodbye and end the call."),
    }


def update_patient(db: Session, args: dict, ctx: dict) -> dict:
    try:
        pid = uuid.UUID(str(args.get("patient_id", "")))
    except ValueError:
        return {"success": False, "error": "invalid_patient_id",
                "instruction": "Call find_patient_by_phone first to get the patient_id."}
    try:
        data = PatientUpdate.model_validate(_patient_args(args))
    except ValidationError as exc:
        return _invalid(exc)
    log.info("agent.update_payload call_id=%s patient_id=%s payload=%s", ctx.get("call_id"), pid,
             json.dumps(data.model_dump(mode="json", exclude_unset=True)))
    try:
        patient = patient_service.update_patient(db, pid, data)
    except patient_service.NotFoundError:
        return {"success": False, "error": "not_found",
                "instruction": "That record no longer exists. Offer to register them as a new patient."}
    except Exception:
        log.exception("agent.update_failed call_id=%s", ctx.get("call_id"))
        return SYSTEM_ERROR
    call_service.link_patient(db, ctx.get("call_id"), patient.patient_id, "updated", ctx.get("caller_number"))
    return {"success": True, "patient": PatientOut.model_validate(patient).model_dump(mode="json"),
            "instruction": f"Updated. Tell the caller 'You're all set, {patient.first_name}.'"}


def get_appointment_slots(db: Session, args: dict, ctx: dict) -> dict:
    slots = appt_service.available_slots(db)[:6]
    return {"success": True, "slots": slots,
            "instruction": "Offer two or three of these times in natural speech (use the `spoken` text)."}


def book_appointment(db: Session, args: dict, ctx: dict) -> dict:
    try:
        appt = appt_service.book(db, uuid.UUID(str(args.get("patient_id"))), str(args.get("slot_start")),
                                 args.get("reason"))
    except (ValueError, patient_service.NotFoundError) as exc:
        return {"success": False, "error": str(exc),
                "instruction": "Apologize and offer the other available times (call get_appointment_slots)."}
    except Exception:
        log.exception("agent.book_failed")
        return SYSTEM_ERROR
    return {"success": True, "appointment_id": str(appt.appointment_id), "provider_name": appt.provider_name,
            "instruction": "Confirm the day, time and doctor, then say goodbye and end the call."}


TOOLS: dict[str, Callable[[Session, dict, dict], dict]] = {
    "find_patient_by_phone": find_patient_by_phone,
    "register_patient": register_patient,
    "update_patient": update_patient,
    "get_appointment_slots": get_appointment_slots,
    "book_appointment": book_appointment,
}


def run_tool(db: Session, name: str, args: Any, ctx: dict) -> dict:
    if isinstance(args, str):  # some providers send arguments as a JSON string
        try:
            args = json.loads(args or "{}")
        except json.JSONDecodeError:
            args = {}
    fn = TOOLS.get(name)
    if fn is None:
        return {"success": False, "error": f"unknown tool {name}"}
    log.info("agent.tool_call call_id=%s tool=%s", ctx.get("call_id"), name)
    try:
        return fn(db, args or {}, ctx)
    except Exception:
        db.rollback()
        log.exception("agent.tool_crashed tool=%s", name)
        return SYSTEM_ERROR
