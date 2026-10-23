from datetime import date, timedelta

import pytest

from app import validation as v


@pytest.mark.parametrize("raw,expected", [("(555) 234-5678", "5552345678"), ("+1 555 234 5678", "5552345678"),
                                          ("555.234.5678", "5552345678")])
def test_phone_ok(raw, expected):
    assert v.validate_us_phone(raw) == expected


@pytest.mark.parametrize("raw", ["555", "12345678901234", "055-234-5678", "155-234-5678"])
def test_phone_bad(raw):
    with pytest.raises(ValueError):
        v.validate_us_phone(raw)


def test_dob_rules():
    assert v.validate_dob("02/29/2000") == date(2000, 2, 29)
    assert v.validate_dob("2000-02-29") == date(2000, 2, 29)
    for bad in ["02/30/2000", "13/01/1990", (date.today() + timedelta(days=1)).strftime("%m/%d/%Y"), "01/01/1800"]:
        with pytest.raises(ValueError):
            v.validate_dob(bad)


def test_names():
    assert v.validate_name("O\u2019Brien") == "O'Brien"
    assert v.validate_name("José") == "José"
    assert v.validate_name("De La Cruz") == "De La Cruz"
    for bad in ["", "J0hn", "a" * 51, "--", "Smith--Jones"]:
        with pytest.raises(ValueError):
            v.validate_name(bad)


def test_state_zip_sex_member():
    assert v.validate_state("california") == "CA" and v.validate_state("tx") == "TX"
    with pytest.raises(ValueError):
        v.validate_state("ZZ")
    assert v.validate_zip("12345-6789") == "12345-6789"
    with pytest.raises(ValueError):
        v.validate_zip("ABCDE")
    assert v.validate_sex("prefer not to say") == "Decline to Answer"
    with pytest.raises(ValueError):
        v.validate_sex("maybe")
    assert v.validate_member_id("abc 123-45") == "ABC12345"
    with pytest.raises(ValueError):
        v.validate_member_id("ABC#123")
