"""ORM models. The schema enforces the assessment's data model with types + CHECK constraints,
so bad data is rejected by the database even if it slips past the API layer."""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON, CheckConstraint, Date, DateTime, Enum, ForeignKey, Index, String, Text, Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Sex(str, enum.Enum):
    MALE = "Male"
    FEMALE = "Female"
    OTHER = "Other"
    DECLINE = "Decline to Answer"


class Patient(Base):
    __tablename__ = "patients"

    patient_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    first_name: Mapped[str] = mapped_column(String(50), nullable=False)
    last_name: Mapped[str] = mapped_column(String(50), nullable=False)
    date_of_birth: Mapped[date] = mapped_column(Date, nullable=False)
    sex: Mapped[Sex] = mapped_column(
        Enum(Sex, name="sex_enum", values_callable=lambda e: [m.value for m in e],
             native_enum=False, create_constraint=True, length=20),
        nullable=False,
    )
    phone_number: Mapped[str] = mapped_column(String(10), nullable=False)
    email: Mapped[str | None] = mapped_column(String(254))
    address_line_1: Mapped[str] = mapped_column(String(200), nullable=False)
    address_line_2: Mapped[str | None] = mapped_column(String(100))
    city: Mapped[str] = mapped_column(String(100), nullable=False)
    state: Mapped[str] = mapped_column(String(2), nullable=False)
    zip_code: Mapped[str] = mapped_column(String(10), nullable=False)
    insurance_provider: Mapped[str | None] = mapped_column(String(100))
    insurance_member_id: Mapped[str | None] = mapped_column(String(50))
    preferred_language: Mapped[str] = mapped_column(String(50), nullable=False, default="English")
    emergency_contact_name: Mapped[str | None] = mapped_column(String(100))
    emergency_contact_phone: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    calls: Mapped[list[CallLog]] = relationship(back_populates="patient", order_by="CallLog.created_at.desc()")
    appointments: Mapped[list[Appointment]] = relationship(
        back_populates="patient", order_by="Appointment.scheduled_for")

    __table_args__ = (
        CheckConstraint("length(first_name) BETWEEN 1 AND 50", name="ck_first_name_len"),
        CheckConstraint("length(last_name) BETWEEN 1 AND 50", name="ck_last_name_len"),
        CheckConstraint("length(phone_number) = 10", name="ck_phone_len"),
        CheckConstraint("emergency_contact_phone IS NULL OR length(emergency_contact_phone) = 10",
                        name="ck_ec_phone_len"),
        CheckConstraint("length(state) = 2", name="ck_state_len"),
        CheckConstraint("length(zip_code) IN (5, 10)", name="ck_zip_len"),
        CheckConstraint("length(city) BETWEEN 1 AND 100", name="ck_city_len"),
        Index("ix_patients_phone", "phone_number"),
        Index("ix_patients_last_name", "last_name"),
        Index("ix_patients_dob", "date_of_birth"),
    )


class CallLog(Base):
    """One row per phone call: transcript + summary, linked to the patient it created/updated."""
    __tablename__ = "call_logs"

    call_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    patient_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("patients.patient_id"))
    caller_number: Mapped[str | None] = mapped_column(String(20))
    outcome: Mapped[str] = mapped_column(String(30), nullable=False, default="in_progress")
    ended_reason: Mapped[str | None] = mapped_column(String(100))
    summary: Mapped[str | None] = mapped_column(Text)
    transcript: Mapped[str | None] = mapped_column(Text)
    collected_data: Mapped[dict | None] = mapped_column(JSON)
    duration_seconds: Mapped[float | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    patient: Mapped[Patient | None] = relationship(back_populates="calls")


class Appointment(Base):
    """Bonus: mock first-appointment scheduling."""
    __tablename__ = "appointments"

    appointment_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    patient_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("patients.patient_id"), nullable=False)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    provider_name: Mapped[str] = mapped_column(String(100), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)

    patient: Mapped[Patient] = relationship(back_populates="appointments")
