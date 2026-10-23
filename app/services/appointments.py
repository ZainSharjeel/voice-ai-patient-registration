"""Bonus: mock appointment scheduling. Slots are generated (next business days) — no real calendar."""
from __future__ import annotations

import uuid
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Appointment
from app.services.patients import get_patient

PROVIDERS = ["Dr. Sarah Mitchell", "Dr. James Patel"]
SLOT_TIMES = [time(9, 0), time(11, 30), time(14, 0), time(16, 0)]


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def available_slots(db: Session, days: int = 3) -> list[dict]:
    tz = ZoneInfo(get_settings().clinic_timezone)
    now = datetime.now(tz)
    # Stored as UTC; SQLite returns naive datetimes, so re-attach UTC before comparing.
    # (Mock scale: scanning all appointments is fine; a real system would query a calendar service.)
    booked = {_as_utc(a.scheduled_for).astimezone(tz) for a in db.scalars(select(Appointment))}
    slots, day = [], now.date()
    while len({s["date"] for s in slots}) < days:
        day += timedelta(days=1)
        if day.weekday() >= 5:  # skip weekends
            continue
        for i, t in enumerate(SLOT_TIMES):
            start = datetime.combine(day, t, tzinfo=tz)
            if start in booked:
                continue
            slots.append({
                "slot_start": start.isoformat(),
                "date": day.isoformat(),
                "spoken": start.strftime("%A, %B %-d at %-I:%M %p").replace(":00 ", " "),
                "provider_name": PROVIDERS[i % len(PROVIDERS)],
            })
    return slots


def book(db: Session, patient_id: uuid.UUID, slot_start: str, reason: str | None = None) -> Appointment:
    get_patient(db, patient_id)  # raises NotFoundError
    match = next((s for s in available_slots(db, days=5) if s["slot_start"] == slot_start), None)
    if match is None:
        raise ValueError("That time slot is no longer available.")
    appt = Appointment(patient_id=patient_id, scheduled_for=datetime.fromisoformat(slot_start).astimezone(timezone.utc),
                       provider_name=match["provider_name"], reason=reason)
    db.add(appt)
    db.commit()
    db.refresh(appt)
    return appt
