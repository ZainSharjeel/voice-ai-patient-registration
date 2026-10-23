"""Integration tests for the Vapi webhook: tool calls -> service layer -> DB, plus failure paths."""
import json

HEADERS = {"x-vapi-secret": "test-secret"}


def tool_call(client, name, args, call_id="call-1"):
    payload = {"message": {"type": "tool-calls", "call": {"id": call_id, "customer": {"number": "+12125550147"}},
                           "toolCallList": [{"id": "tc-1", "type": "function",
                                             "function": {"name": name, "arguments": args}}]}}
    r = client.post("/vapi/webhook", json=payload, headers=HEADERS)
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["toolCallId"] == "tc-1"
    return json.loads(res["result"])


def test_webhook_requires_secret(client):
    r = client.post("/vapi/webhook", json={"message": {"type": "status-update"}})
    assert r.status_code == 401


def test_register_persists_and_is_visible_via_api(client, valid_patient):
    res = tool_call(client, "register_patient", valid_patient)
    assert res["success"] is True
    p = client.get(f"/patients/{res['patient_id']}").json()["data"]
    assert p["last_name"] == "O'Neil-Smith"


def test_register_with_string_arguments(client, valid_patient):
    assert tool_call(client, "register_patient", json.dumps(valid_patient))["success"] is True


def test_invalid_fields_are_reported_per_field(client, valid_patient):
    res = tool_call(client, "register_patient", {**valid_patient, "phone_number": "555", "date_of_birth": "01/01/2999"})
    assert res["success"] is False and res["error"] == "validation_failed"
    assert {e["field"] for e in res["invalid_fields"]} == {"phone_number", "date_of_birth"}
    assert client.get("/patients").json()["data"] == []


def test_duplicate_detection_and_update_flow(client, valid_patient):
    first = tool_call(client, "register_patient", valid_patient)
    found = tool_call(client, "find_patient_by_phone", {"phone_number": "212-555-0147"})
    assert found["found"] is True and found["patient"]["first_name"] == "Jane"
    dup = tool_call(client, "register_patient", valid_patient)
    assert dup["error"] == "possible_duplicate"
    upd = tool_call(client, "update_patient", {"patient_id": first["patient_id"], "last_name": "Davis"})
    assert upd["success"] is True and upd["patient"]["last_name"] == "Davis"
    # family member sharing the phone can still register when the caller confirms
    other = tool_call(client, "register_patient", {**valid_patient, "first_name": "Tom", "allow_duplicate_phone": True})
    assert other["success"] is True


def test_db_failure_returns_graceful_error(client, valid_patient, monkeypatch):
    from app.services import patients as svc

    def boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(svc, "create_patient", boom)
    res = tool_call(client, "register_patient", valid_patient)
    assert res["success"] is False and res["error"] == "system_error"
    assert "NOT saved" in res["instruction"]


def test_end_of_call_report_links_transcript(client, valid_patient):
    res = tool_call(client, "register_patient", valid_patient, call_id="call-xyz")
    report = {"message": {"type": "end-of-call-report", "call": {"id": "call-xyz"}, "endedReason": "assistant-ended-call",
                          "artifact": {"transcript": "AI: Hi\nUser: Hello"}, "analysis": {"summary": "Registered Jane."}}}
    assert client.post("/vapi/webhook", json=report, headers=HEADERS).status_code == 200
    calls = client.get(f"/patients/{res['patient_id']}/calls").json()["data"]
    assert calls[0]["outcome"] == "registered" and "Hello" in calls[0]["transcript"]


def test_dropped_call_is_logged_incomplete(client):
    report = {"message": {"type": "end-of-call-report", "call": {"id": "call-drop"}, "endedReason": "customer-ended-call",
                          "artifact": {"transcript": "AI: Hi\nUser: My name is"}}}
    client.post("/vapi/webhook", json=report, headers=HEADERS)
    calls = client.get("/calls").json()["data"]
    assert calls[0]["call_id"] == "call-drop" and calls[0]["outcome"] == "incomplete"


def test_appointment_booking(client, valid_patient):
    pid = tool_call(client, "register_patient", valid_patient)["patient_id"]
    slots = tool_call(client, "get_appointment_slots", {})["slots"]
    assert slots
    booked = tool_call(client, "book_appointment", {"patient_id": pid, "slot_start": slots[0]["slot_start"]})
    assert booked["success"] is True
    assert slots[0]["slot_start"] not in [s["slot_start"] for s in tool_call(client, "get_appointment_slots", {})["slots"]]
    assert len(client.get(f"/patients/{pid}/appointments").json()["data"]) == 1
