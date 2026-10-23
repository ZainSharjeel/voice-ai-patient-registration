"""Call log service: links each phone call (transcript/summary/outcome) to a patient record."""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CallLog

log = logging.getLogger("calls")


def upsert_call(db: Session, call_id: str, **fields: Any) -> CallLog:
    call = db.get(CallLog, call_id)
    if call is None:
        call = CallLog(call_id=call_id)
        db.add(call)
    for key, value in fields.items():
        if value is not None:
            setattr(call, key, value)
    db.commit()
    db.refresh(call)
    return call


def link_patient(db: Session, call_id: str | None, patient_id: uuid.UUID, outcome: str,
                 caller_number: str | None = None) -> None:
    """Best-effort: never let call bookkeeping break the patient write."""
    if not call_id:
        return
    try:
        upsert_call(db, call_id, patient_id=patient_id, outcome=outcome, caller_number=caller_number)
    except Exception:  # pragma: no cover - logged, not fatal
        db.rollback()
        log.exception("call.link_failed call_id=%s", call_id)


def list_calls(db: Session, patient_id: uuid.UUID | None = None, limit: int = 100) -> list[CallLog]:
    stmt = select(CallLog).order_by(CallLog.created_at.desc()).limit(limit)
    if patient_id:
        stmt = stmt.where(CallLog.patient_id == patient_id)
    return list(db.scalars(stmt))
