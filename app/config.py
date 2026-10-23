"""Runtime configuration — everything comes from environment variables (no secrets in code)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _normalize_db_url(url: str) -> str:
    # Railway/Heroku style URLs use `postgres://` or `postgresql://`; SQLAlchemy needs the driver name.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


@dataclass(frozen=True)
class Settings:
    database_url: str
    vapi_webhook_secret: str | None
    public_base_url: str | None
    clinic_name: str
    clinic_timezone: str
    seed_demo_data: bool
    log_level: str


@lru_cache
def get_settings() -> Settings:
    return Settings(
        database_url=_normalize_db_url(os.getenv("DATABASE_URL", "sqlite:///./data/patients.db")),
        vapi_webhook_secret=os.getenv("VAPI_WEBHOOK_SECRET") or None,
        public_base_url=(os.getenv("PUBLIC_BASE_URL") or "").rstrip("/") or None,
        clinic_name=os.getenv("CLINIC_NAME", "CareCloud Family Medicine"),
        clinic_timezone=os.getenv("CLINIC_TIMEZONE", "America/New_York"),
        seed_demo_data=os.getenv("SEED_DEMO_DATA", "true").lower() in {"1", "true", "yes"},
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
