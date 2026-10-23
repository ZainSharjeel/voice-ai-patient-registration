"""Patient service layer — the single place that reads/writes patients.
Used by both the REST API and the voice-agent tools (one source of truth for business rules)."""
from __future__ import annotations

import logging
import uuid
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Patient, Sex, utcnow
from app.schemas import PatientCreate, PatientUpdate

log = logging.getLogger("patients")


class NotFoundError(Exception):
    pass


def _active():
    return select(Patient).where(Patient.deleted_at.is_(None))


def create_patient(db: Session, data: PatientCreate) -> Patient:
    values = data.model_dump()
    values["sex"] = Sex(values["sex"])
    patient = Patient(**values)
    db.add(patient)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(patient)
    log.info("patient.created id=%s", patient.patient_id)
    return patient


def get_patient(db: Session, patient_id: uuid.UUID) -> Patient:
    patient = db.scalar(_active().where(Patient.patient_id == patient_id))
    if patient is None:
        raise NotFoundError(f"Patient {patient_id} not found")
    return patient


def list_patients(db: Session, *, last_name: str | None = None, date_of_birth: date | None = None,
                  phone_number: str | None = None, limit: int = 100, offset: int = 0) -> list[Patient]:
    stmt = _active()
    if last_name:
        stmt = stmt.where(func.lower(Patient.last_name) == last_name.strip().lower())
    if date_of_birth:
        stmt = stmt.where(Patient.date_of_birth == date_of_birth)
    if phone_number:
        stmt = stmt.where(Patient.phone_number == phone_number)
    stmt = stmt.order_by(Patient.created_at.desc()).limit(limit).offset(offset)
    return list(db.scalars(stmt))


def find_by_phone(db: Session, phone_number: str) -> list[Patient]:
    return list_patients(db, phone_number=phone_number, limit=5)


def update_patient(db: Session, patient_id: uuid.UUID, data: PatientUpdate) -> Patient:
    patient = get_patient(db, patient_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        if field == "sex" and value is not None:
            value = Sex(value)
        setattr(patient, field, value)
    patient.updated_at = utcnow()
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(patient)
    log.info("patient.updated id=%s fields=%s", patient_id, sorted(data.model_fields_set))
    return patient


def soft_delete_patient(db: Session, patient_id: uuid.UUID) -> Patient:
    patient = get_patient(db, patient_id)
    patient.deleted_at = utcnow()
    patient.updated_at = patient.deleted_at
    db.commit()
    db.refresh(patient)
    log.info("patient.soft_deleted id=%s", patient_id)
    return patient
