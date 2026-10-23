"""REST endpoints for patients (+ their calls and appointments)."""
from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import validation as v
from app.api.responses import ok
from app.db import get_db
from app.schemas import AppointmentOut, CallOut, PatientCreate, PatientOut, PatientUpdate
from app.services import calls as call_service
from app.services import patients as service

router = APIRouter(prefix="/patients", tags=["patients"])
DB = Annotated[Session, Depends(get_db)]


def _parse_id(patient_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(patient_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="patient_id must be a valid UUID.")


def _object_body(body: Any) -> dict:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object.")
    return body


def _out(p) -> dict:
    return PatientOut.model_validate(p).model_dump(mode="json")


@router.get("")
def list_patients(db: DB,
                  last_name: str | None = None,
                  date_of_birth: str | None = Query(None, description="MM/DD/YYYY or YYYY-MM-DD"),
                  phone_number: str | None = None,
                  limit: int = Query(100, ge=1, le=500),
                  offset: int = Query(0, ge=0)):
    try:
        dob = v.validate_dob(date_of_birth) if date_of_birth else None
        phone = v.validate_us_phone(phone_number) if phone_number else None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    rows = service.list_patients(db, last_name=last_name, date_of_birth=dob, phone_number=phone,
                                 limit=limit, offset=offset)
    return ok([_out(p) for p in rows], meta={"count": len(rows), "limit": limit, "offset": offset})


@router.get("/{patient_id}")
def get_patient(patient_id: str, db: DB):
    return ok(_out(service.get_patient(db, _parse_id(patient_id))))


@router.post("", status_code=201)
def create_patient(db: DB, body: Any = Body(...)):
    patient = service.create_patient(db, PatientCreate.model_validate(_object_body(body)))
    return ok(_out(patient), status_code=201)


@router.put("/{patient_id}")
def update_patient(patient_id: str, db: DB, body: Any = Body(...)):
    pid = _parse_id(patient_id)
    patient = service.update_patient(db, pid, PatientUpdate.model_validate(_object_body(body)))
    return ok(_out(patient))


@router.delete("/{patient_id}")
def delete_patient(patient_id: str, db: DB):
    patient = service.soft_delete_patient(db, _parse_id(patient_id))
    return ok({"patient_id": str(patient.patient_id), "deleted_at": patient.deleted_at.isoformat()})


@router.get("/{patient_id}/calls")
def patient_calls(patient_id: str, db: DB):
    patient = service.get_patient(db, _parse_id(patient_id))
    return ok([CallOut.model_validate(c).model_dump(mode="json") for c in patient.calls])


@router.get("/{patient_id}/appointments")
def patient_appointments(patient_id: str, db: DB):
    patient = service.get_patient(db, _parse_id(patient_id))
    return ok([AppointmentOut.model_validate(a).model_dump(mode="json") for a in patient.appointments])


calls_router = APIRouter(prefix="/calls", tags=["calls"])


@calls_router.get("")
def list_calls(db: DB, limit: int = Query(100, ge=1, le=500)):
    return ok([CallOut.model_validate(c).model_dump(mode="json") for c in call_service.list_calls(db, limit=limit)])
