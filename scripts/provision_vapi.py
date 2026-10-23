"""Create/update the Vapi assistant from code and attach a free U.S. phone number to it.

Idempotent: re-running updates the existing assistant (matched by name) instead of duplicating it.

Usage:
    VAPI_API_KEY=... PUBLIC_BASE_URL=https://<app>.up.railway.app VAPI_WEBHOOK_SECRET=... \
        python scripts/provision_vapi.py [--area-code 415]
"""
from __future__ import annotations

import argparse
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.agent.assistant_config import build_assistant  # noqa: E402

API = "https://api.vapi.ai"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--area-code", default=None, help="Preferred U.S. area code for a new number")
    args = parser.parse_args()

    key, base_url = os.environ["VAPI_API_KEY"], os.environ["PUBLIC_BASE_URL"]
    clinic = os.getenv("CLINIC_NAME", "CareCloud Family Medicine")
    config = build_assistant(base_url, os.getenv("VAPI_WEBHOOK_SECRET"), clinic)
    client = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=30)

    existing = next((a for a in client.get("/assistant").raise_for_status().json()
                     if a.get("name") == config["name"]), None)
    if existing:
        r = client.patch(f"/assistant/{existing['id']}", json=config)
    else:
        r = client.post("/assistant", json=config)
    if r.is_error:
        sys.exit(f"Assistant upsert failed: {r.status_code} {r.text}")
    assistant = r.json()
    print(f"assistant: {assistant['id']} ({'updated' if existing else 'created'})")

    numbers = client.get("/phone-number").raise_for_status().json()
    number = next((n for n in numbers if n.get("assistantId") == assistant["id"]), None) or \
        next((n for n in numbers if not n.get("assistantId")), None)
    if number:
        number = client.patch(f"/phone-number/{number['id']}", json={"assistantId": assistant["id"]}).raise_for_status().json()
    else:
        body = {"provider": "vapi", "assistantId": assistant["id"], "name": "Patient Intake Line"}
        if args.area_code:
            body["numberDesiredAreaCode"] = args.area_code
        r = client.post("/phone-number", json=body)
        if r.is_error:
            sys.exit(f"Phone number provisioning failed: {r.status_code} {r.text}")
        number = r.json()
    print(f"phone_number: {number.get('number') or '(activating…)'} id={number['id']}")


if __name__ == "__main__":
    main()
