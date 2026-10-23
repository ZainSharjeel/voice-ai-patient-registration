import os
import tempfile

import pytest

# Isolated SQLite DB per test session; must be set before the app is imported.
_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["SEED_DEMO_DATA"] = "false"
os.environ["VAPI_WEBHOOK_SECRET"] = "test-secret"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


VALID = {
    "first_name": "Jane", "last_name": "O'Neil-Smith", "date_of_birth": "03/14/1985", "sex": "female",
    "phone_number": "(212) 555-0147", "email": "jane@example.com", "address_line_1": "123 Main St",
    "address_line_2": "Apt 4B", "city": "New York", "state": "ny", "zip_code": "10001",
}


@pytest.fixture()
def valid_patient():
    return dict(VALID)
