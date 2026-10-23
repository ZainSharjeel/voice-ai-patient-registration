"""FastAPI application entrypoint: wires routers, error envelope, logging, DB init and seed data."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from sqlalchemy import text

from app.api import patients, vapi
from app.api.responses import err, install_error_handlers, ok
from app.config import get_settings
from app.db import SessionLocal, engine, init_db
from app.services.seed import seed_if_empty

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    if settings.seed_demo_data:
        with SessionLocal() as db:
            seed_if_empty(db)
    log.info("startup.ready db=%s", engine.url.get_backend_name())
    yield


app = FastAPI(title="Voice AI Patient Registration API", version="1.0.0", lifespan=lifespan,
              description="REST API + Vapi webhook for a voice agent that registers U.S. patients.")
install_error_handlers(app)
app.include_router(patients.router)
app.include_router(patients.calls_router)
app.include_router(vapi.router)


@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
def dashboard():
    return FileResponse(STATIC / "dashboard.html")


@app.get("/health", tags=["ops"])
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        log.exception("health.db_unreachable")
        return err(500, "db_unavailable", "Database is unreachable.")
    return ok({"status": "ok", "database": engine.url.get_backend_name()})
