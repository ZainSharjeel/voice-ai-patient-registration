"""Pydantic request/response schemas. All server-side validation funnels through app.validation."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, field_serializer, field_validator, model_validator

from app import validation as v

REQUIRED_FIELDS = (
    "first_name", "last_name", "date_of_birth", "sex", "phone_number",
    "address_line_1", "city", "state", "zip_code",
)


def _blank_to_none(value: Any) -> Any:
    return None if isinstance(value, str) and not value.strip() else value


class _PatientFields(BaseModel):
    """Field-level rules shared by create + update."""
    model_config = ConfigDict(extra="forbid")

    first_name: str | None = None
    last_name: str | None = None
    date_of_birth: date | str | None = None
    sex: str | None = None
    phone_number: str | None = None
    email: str | None = None
    address_line_1: str | None = None
    address_line_2: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    insurance_provider: str | None = None
    insurance_member_id: str | None = None
    preferred_language: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_phone: str | None = None

    @field_validator("*", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return _blank_to_none(value)

    @field_validator("first_name")
    @classmethod
    def _first(cls, x): return None if x is None else v.validate_name(x, "First name")

    @field_validator("last_name")
    @classmethod
    def _last(cls, x): return None if x is None else v.validate_name(x, "Last name")

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, x): return None if x is None else v.validate_dob(x)

    @field_validator("sex")
    @classmethod
    def _sex(cls, x): return None if x is None else v.validate_sex(x)

    @field_validator("phone_number")
    @classmethod
    def _phone(cls, x): return None if x is None else v.validate_us_phone(x)

    @field_validator("emergency_contact_phone")
    @classmethod
    def _ec_phone(cls, x):
        return None if x is None else v.validate_us_phone(x, "Emergency contact phone")

    @field_validator("email")
    @classmethod
    def _email(cls, x): return None if x is None else v.validate_email_addr(x)

    @field_validator("address_line_1")
    @classmethod
    def _addr1(cls, x): return None if x is None else v.validate_free_text(x, "Street address", 200)

    @field_validator("address_line_2")
    @classmethod
    def _addr2(cls, x): return None if x is None else v.validate_free_text(x, "Address line 2", 100)

    @field_validator("city")
    @classmethod
    def _city(cls, x): return None if x is None else v.validate_free_text(x, "City", 100)

    @field_validator("state")
    @classmethod
    def _state(cls, x): return None if x is None else v.validate_state(x)

    @field_validator("zip_code")
    @classmethod
    def _zip(cls, x): return None if x is None else v.validate_zip(x)

    @field_validator("insurance_provider")
    @classmethod
    def _ins(cls, x): return None if x is None else v.validate_free_text(x, "Insurance provider", 100)

    @field_validator("insurance_member_id")
    @classmethod
    def _member(cls, x): return None if x is None else v.validate_member_id(x)

    @field_validator("preferred_language")
    @classmethod
    def _lang(cls, x): return None if x is None else v.validate_name(x, "Preferred language")

    @field_validator("emergency_contact_name")
    @classmethod
    def _ec_name(cls, x):
        return None if x is None else v.validate_name(x, "Emergency contact name", 100)


class PatientCreate(_PatientFields):
    @model_validator(mode="after")
    def _required(self):
        missing = [f for f in REQUIRED_FIELDS if getattr(self, f) is None]
        if missing:
            raise ValueError(f"Missing required field(s): {', '.join(missing)}.")
        if self.preferred_language is None:
            self.preferred_language = "English"
        return self


class PatientUpdate(_PatientFields):
    """Partial update: only provided keys change. Required fields may not be cleared."""

    @model_validator(mode="after")
    def _no_clearing_required(self):
        cleared = [f for f in REQUIRED_FIELDS if f in self.model_fields_set and getattr(self, f) is None]
        if cleared:
            raise ValueError(f"Required field(s) cannot be empty: {', '.join(cleared)}.")
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to update.")
        return self


def _iso_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:  # SQLite drops tzinfo; values are always stored as UTC.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class PatientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    patient_id: uuid.UUID
    first_name: str
    last_name: str
    date_of_birth: date
    sex: str
    phone_number: str
    email: str | None
    address_line_1: str
    address_line_2: str | None
    city: str
    state: str
    zip_code: str
    insurance_provider: str | None
    insurance_member_id: str | None
    preferred_language: str
    emergency_contact_name: str | None
    emergency_contact_phone: str | None
    created_at: datetime
    updated_at: datetime

    @field_validator("sex", mode="before")
    @classmethod
    def _enum_value(cls, x): return getattr(x, "value", x)

    @field_serializer("date_of_birth")
    def _ser_dob(self, d: date) -> str: return d.strftime("%m/%d/%Y")

    @field_serializer("created_at", "updated_at")
    def _ser_ts(self, dt: datetime) -> str | None: return _iso_utc(dt)


class CallOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    call_id: str
    patient_id: uuid.UUID | None
    caller_number: str | None
    outcome: str
    ended_reason: str | None
    summary: str | None
    transcript: str | None
    collected_data: dict | None
    duration_seconds: float | None
    created_at: datetime

    @field_serializer("created_at")
    def _ser_ts(self, dt: datetime) -> str | None: return _iso_utc(dt)


class AppointmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    appointment_id: uuid.UUID
    patient_id: uuid.UUID
    scheduled_for: datetime
    provider_name: str
    reason: str | None

    @field_serializer("scheduled_for")
    def _ser_ts(self, dt: datetime) -> str | None: return _iso_utc(dt)
