from datetime import date, timedelta


def create(client, payload):
    return client.post("/patients", json=payload)


def test_create_returns_201_with_envelope_and_normalized_fields(client, valid_patient):
    r = create(client, valid_patient)
    assert r.status_code == 201
    body = r.json()
    assert body["error"] is None
    p = body["data"]
    assert p["patient_id"]
    assert p["phone_number"] == "2125550147"
    assert p["state"] == "NY" and p["sex"] == "Female"
    assert p["date_of_birth"] == "03/14/1985"
    assert p["preferred_language"] == "English"
    assert p["created_at"].endswith("Z")


def test_get_and_list_with_filters(client, valid_patient):
    pid = create(client, valid_patient).json()["data"]["patient_id"]
    assert client.get(f"/patients/{pid}").json()["data"]["first_name"] == "Jane"
    assert len(client.get("/patients?last_name=o'neil-smith").json()["data"]) == 1
    assert len(client.get("/patients?date_of_birth=03/14/1985").json()["data"]) == 1
    assert len(client.get("/patients?phone_number=212-555-0147").json()["data"]) == 1
    assert client.get("/patients?last_name=Nobody").json()["data"] == []


def test_validation_errors_are_422_with_field_details(client, valid_patient):
    bad = {**valid_patient, "phone_number": "555", "date_of_birth": (date.today() + timedelta(days=3)).strftime("%m/%d/%Y"),
           "state": "XX", "zip_code": "1234"}
    r = create(client, bad)
    assert r.status_code == 422
    fields = {d["field"] for d in r.json()["error"]["details"]}
    assert {"phone_number", "date_of_birth", "state", "zip_code"} <= fields
    assert r.json()["data"] is None


def test_missing_required_and_unknown_fields(client, valid_patient):
    payload = {k: v for k, v in valid_patient.items() if k != "city"}
    assert create(client, payload).status_code == 422
    assert create(client, {**valid_patient, "is_admin": True}).status_code == 422


def test_bad_json_and_bad_uuid_are_400(client):
    r = client.post("/patients", content="{not json", headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert client.get("/patients/not-a-uuid").status_code == 400
    assert client.post("/patients", json=[1, 2]).status_code == 400


def test_404_for_unknown_patient(client):
    r = client.get("/patients/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_partial_update(client, valid_patient):
    created = create(client, valid_patient).json()["data"]
    r = client.put(f"/patients/{created['patient_id']}", json={"last_name": "Davis", "zip_code": "100011234"})
    assert r.status_code == 200
    p = r.json()["data"]
    assert p["last_name"] == "Davis" and p["zip_code"] == "10001-1234" and p["city"] == "New York"
    assert p["updated_at"] >= created["updated_at"]
    assert client.put(f"/patients/{created['patient_id']}", json={"first_name": None}).status_code == 422
    assert client.put(f"/patients/{created['patient_id']}", json={}).status_code == 422


def test_soft_delete(client, valid_patient):
    pid = create(client, valid_patient).json()["data"]["patient_id"]
    r = client.delete(f"/patients/{pid}")
    assert r.status_code == 200 and r.json()["data"]["deleted_at"]
    assert client.get(f"/patients/{pid}").status_code == 404
    assert client.get("/patients").json()["data"] == []
    # row still exists in the DB (soft delete)
    from app.db import SessionLocal
    from app.models import Patient
    import uuid
    with SessionLocal() as db:
        assert db.get(Patient, uuid.UUID(pid)).deleted_at is not None


def test_input_sanitization(client, valid_patient):
    r = create(client, {**valid_patient, "first_name": "  Ja\x00ne  ", "city": "  New   York "})
    assert r.status_code == 201
    assert r.json()["data"]["first_name"] == "Jane" and r.json()["data"]["city"] == "New York"
    assert create(client, {**valid_patient, "first_name": "<script>"}).status_code == 422


def test_health_and_dashboard(client):
    assert client.get("/health").json()["data"]["status"] == "ok"
    assert "Patient Registry" in client.get("/dashboard").text
