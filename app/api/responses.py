"""Consistent JSON envelope: {"data": ..., "error": null} / {"data": null, "error": {...}}."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.services.patients import NotFoundError

log = logging.getLogger("api")


def ok(data: Any, status_code: int = 200, meta: dict | None = None) -> JSONResponse:
    body = {"data": jsonable_encoder(data), "error": None}
    if meta is not None:
        body["meta"] = meta
    return JSONResponse(status_code=status_code, content=body)


def err(status_code: int, code: str, message: str, details: list | None = None) -> JSONResponse:
    error = {"code": code, "message": message}
    if details:
        error["details"] = details
    return JSONResponse(status_code=status_code, content={"data": None, "error": error})


def _format_errors(errors: list[dict]) -> list[dict]:
    out = []
    for e in errors:
        loc = [str(p) for p in e.get("loc", []) if p not in ("body", "query", "path")]
        msg = e.get("msg", "Invalid value").removeprefix("Value error, ")
        out.append({"field": ".".join(loc) or None, "message": msg})
    return out


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        errors = exc.errors()
        # Malformed JSON body is a 400 (bad request), not a 422 (semantic validation).
        if any(e.get("type") == "json_invalid" for e in errors):
            return err(400, "bad_request", "Request body is not valid JSON.")
        return err(422, "validation_error", "One or more fields are invalid.", _format_errors(errors))

    @app.exception_handler(ValidationError)
    async def _pyd_validation(_: Request, exc: ValidationError):
        return err(422, "validation_error", "One or more fields are invalid.", _format_errors(exc.errors()))

    @app.exception_handler(NotFoundError)
    async def _not_found(_: Request, exc: NotFoundError):
        return err(404, "not_found", str(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        code = {400: "bad_request", 401: "unauthorized", 404: "not_found", 405: "method_not_allowed"}
        return err(exc.status_code, code.get(exc.status_code, "error"), str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("unhandled_error")
        return err(500, "internal_error", "An unexpected error occurred.")
