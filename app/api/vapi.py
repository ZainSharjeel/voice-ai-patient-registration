"""Vapi webhook adapter: translates Vapi server messages <-> our provider-agnostic tools.

Telephony/STT/TTS live in Vapi; this module is the only Vapi-specific code in the backend.
"""
from __future__ import annotations

import hmac
import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.agent.tools import run_tool
from app.config import get_settings
from app.db import get_db
from app.services import calls as call_service

router = APIRouter(prefix="/vapi", tags=["voice-agent"])
log = logging.getLogger("vapi")


def _verify(secret: str | None) -> None:
    expected = get_settings().vapi_webhook_secret
    if expected and not hmac.compare_digest(secret or "", expected):
        raise HTTPException(status_code=401, detail="Invalid webhook secret.")


def _call_ctx(message: dict) -> dict:
    call = message.get("call") or {}
    customer = message.get("customer") or call.get("customer") or {}
    return {"call_id": call.get("id"), "caller_number": customer.get("number")}


@router.post("/webhook")
async def webhook(request: Request, db: Annotated[Session, Depends(get_db)],
                  x_vapi_secret: Annotated[str | None, Header()] = None) -> Any:
    _verify(x_vapi_secret)
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Body must be JSON.")
    message = payload.get("message") or {}
    mtype = message.get("type")
    ctx = _call_ctx(message)

    if mtype == "tool-calls":
        results = []
        for tc in message.get("toolCallList") or []:
            fn = tc.get("function") or {}
            result = run_tool(db, fn.get("name", ""), fn.get("arguments"), ctx)
            log.info("vapi.tool_result call_id=%s tool=%s success=%s", ctx["call_id"], fn.get("name"),
                     result.get("success"))
            results.append({"toolCallId": tc.get("id"), "result": json.dumps(result)})
        return {"results": results}

    if mtype == "end-of-call-report":
        _store_end_of_call(db, message, ctx)
        return {"ok": True}

    if mtype == "status-update":
        log.info("vapi.status call_id=%s status=%s", ctx["call_id"], message.get("status"))
        if ctx["call_id"] and message.get("status") == "in-progress":
            call_service.upsert_call(db, ctx["call_id"], caller_number=ctx["caller_number"])
    return {"ok": True}


def _store_end_of_call(db: Session, message: dict, ctx: dict) -> None:
    """Persist transcript + summary. Also covers dropped calls: a call that ends before a
    registration is stored with outcome=incomplete so staff can follow up."""
    artifact = message.get("artifact") or {}
    analysis = message.get("analysis") or {}
    transcript = artifact.get("transcript") or message.get("transcript")
    summary = analysis.get("summary") or message.get("summary")
    ended_reason = message.get("endedReason")
    log.info("vapi.end_of_call call_id=%s ended_reason=%s\n--- transcript ---\n%s", ctx["call_id"],
             ended_reason, transcript)
    if not ctx["call_id"]:
        return
    existing = call_service.upsert_call(db, ctx["call_id"], caller_number=ctx["caller_number"])
    outcome = existing.outcome if existing.outcome in {"registered", "updated"} else "incomplete"
    call_service.upsert_call(
        db, ctx["call_id"], transcript=transcript, summary=summary, ended_reason=ended_reason,
        outcome=outcome, duration_seconds=message.get("durationSeconds"),
        collected_data=analysis.get("structuredData"),
    )
