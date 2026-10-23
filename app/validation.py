"""Pure, framework-free validators/normalizers for patient fields.

Shared by the REST API (via Pydantic) and the voice-agent tools, so both channels enforce exactly
the same rules. Error messages are written to be readable aloud by the agent ("plain English").
"""
from __future__ import annotations

import re
from datetime import date, datetime

from email_validator import EmailNotValidError, validate_email

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
    "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
    "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "DC": "District of Columbia",
    "PR": "Puerto Rico", "VI": "U.S. Virgin Islands", "GU": "Guam", "AS": "American Samoa",
    "MP": "Northern Mariana Islands",
}
_STATE_BY_NAME = {name.lower(): code for code, name in US_STATES.items()}

# Letters (incl. accented), joined by single hyphens, apostrophes or spaces: O'Brien, Smith-Jones, De La Cruz.
_NAME_RE = re.compile(r"^[^\W\d_]+(?:[-' ][^\W\d_]+)*$")
_ZIP_RE = re.compile(r"^\d{5}(?:-\d{4})?$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def clean_text(value: str) -> str:
    """Basic sanitization: strip control characters, collapse whitespace."""
    return re.sub(r"\s+", " ", _CONTROL_RE.sub("", value)).strip()


def validate_name(value: str, label: str = "Name", max_len: int = 50) -> str:
    v = clean_text(value).replace("\u2019", "'")
    if not 1 <= len(v) <= max_len:
        raise ValueError(f"{label} must be between 1 and {max_len} characters.")
    if not _NAME_RE.match(v):
        raise ValueError(f"{label} can only contain letters, hyphens and apostrophes.")
    return v


def validate_dob(value: str | date) -> date:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        d = value
    else:
        s = clean_text(str(value))
        d = None
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y"):
            try:
                d = datetime.strptime(s, fmt).date()
                break
            except ValueError:
                continue
        if d is None:
            raise ValueError("Date of birth must be a real date in MM/DD/YYYY format.")
    today = date.today()
    if d > today:
        raise ValueError("Date of birth cannot be in the future.")
    if d.year < today.year - 130:
        raise ValueError("Date of birth is too far in the past to be valid.")
    return d


def validate_us_phone(value: str, label: str = "Phone number") -> str:
    """Return the 10-digit form. Accepts (555) 123-4567, 555.123.4567, +1 555 123 4567, ..."""
    digits = re.sub(r"\D", "", str(value))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        raise ValueError(f"{label} must be a 10-digit U.S. number (got {len(digits)} digits).")
    if digits[0] in "01":
        raise ValueError(f"{label} has an invalid area code; U.S. area codes cannot start with 0 or 1.")
    return digits


def validate_state(value: str) -> str:
    v = clean_text(value)
    code = v.upper().replace(".", "")
    if code in US_STATES:
        return code
    if v.lower() in _STATE_BY_NAME:  # be forgiving: "California" -> "CA"
        return _STATE_BY_NAME[v.lower()]
    raise ValueError("State must be a valid 2-letter U.S. state abbreviation, like CA or NY.")


def validate_zip(value: str) -> str:
    v = clean_text(str(value)).replace(" ", "")
    if re.fullmatch(r"\d{9}", v):
        v = f"{v[:5]}-{v[5:]}"
    if not _ZIP_RE.match(v):
        raise ValueError("ZIP code must be 5 digits, or ZIP+4 like 12345-6789.")
    return v


def validate_sex(value: str) -> str:
    v = clean_text(value).lower()
    mapping = {
        "male": "Male", "m": "Male", "man": "Male",
        "female": "Female", "f": "Female", "woman": "Female",
        "other": "Other", "non-binary": "Other", "nonbinary": "Other",
        "decline to answer": "Decline to Answer", "decline": "Decline to Answer",
        "prefer not to say": "Decline to Answer", "prefer not to answer": "Decline to Answer",
    }
    if v not in mapping:
        raise ValueError("Sex must be one of: Male, Female, Other, or Decline to Answer.")
    return mapping[v]


def validate_email_addr(value: str) -> str:
    try:
        return validate_email(clean_text(value), check_deliverability=False).normalized
    except EmailNotValidError as exc:
        raise ValueError("Email address is not in a valid format.") from exc


def validate_member_id(value: str) -> str:
    v = re.sub(r"[\s-]", "", clean_text(value)).upper()
    if not v or not v.isalnum() or not v.isascii() or len(v) > 50:
        raise ValueError("Insurance member ID must be letters and numbers only (max 50).")
    return v


def validate_free_text(value: str, label: str, max_len: int, min_len: int = 1) -> str:
    v = clean_text(value)
    if not min_len <= len(v) <= max_len:
        raise ValueError(f"{label} must be between {min_len} and {max_len} characters.")
    if not re.search(r"[A-Za-z0-9]", v):
        raise ValueError(f"{label} must contain letters or numbers.")
    return v
