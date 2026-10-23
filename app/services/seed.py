"""Optional demo records so the API/dashboard are not empty on first boot."""
from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Patient
from app.schemas import PatientCreate
from app.services.patients import create_patient

log = logging.getLogger("seed")

SEED_PATIENTS = [
    dict(first_name="Jane", last_name="Doe", date_of_birth="03/14/1985", sex="Female",
         phone_number="2125550147", email="jane.doe@example.com", address_line_1="123 Main Street",
         address_line_2="Apt 4B", city="New York", state="NY", zip_code="10001",
         insurance_provider="Aetna", insurance_member_id="AET123456789", preferred_language="English",
         emergency_contact_name="John Doe", emergency_contact_phone="2125550148"),
    dict(first_name="Carlos", last_name="Rivera", date_of_birth="11/02/1972", sex="Male",
         phone_number="3055550199", address_line_1="450 Ocean Drive", city="Miami", state="FL",
         zip_code="33139", preferred_language="Spanish"),
]


def seed_if_empty(db: Session) -> None:
    if db.scalar(select(func.count()).select_from(Patient)):
        return
    for record in SEED_PATIENTS:
        create_patient(db, PatientCreate(**record))
    log.info("seed.inserted count=%d", len(SEED_PATIENTS))
