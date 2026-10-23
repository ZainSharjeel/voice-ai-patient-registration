/**
 * Pure, framework-free validators/normalizers for patient fields.
 *
 * Shared by the REST API and the voice-agent tools, so both channels enforce exactly the same
 * rules. Error messages are plain English because the agent reads them aloud to the caller.
 */

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico",
  VI: "U.S. Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
};
const STATE_BY_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

export const SEX_VALUES = ["Male", "Female", "Other", "Decline to Answer"] as const;
export type Sex = (typeof SEX_VALUES)[number];

export const REQUIRED_FIELDS = [
  "first_name", "last_name", "date_of_birth", "sex", "phone_number",
  "address_line_1", "city", "state", "zip_code",
] as const;

export const PATIENT_FIELDS = [
  "first_name", "last_name", "date_of_birth", "sex", "phone_number", "email",
  "address_line_1", "address_line_2", "city", "state", "zip_code",
  "insurance_provider", "insurance_member_id", "preferred_language",
  "emergency_contact_name", "emergency_contact_phone",
] as const;
export type PatientField = (typeof PATIENT_FIELDS)[number];

/** Normalized, validated patient values (date_of_birth stored as ISO YYYY-MM-DD). */
export type PatientValues = Partial<Record<PatientField, string>>;
export type FieldError = { field: string | null; message: string };

export class ValidationError extends Error {
  details: FieldError[];
  constructor(details: FieldError[]) {
    super("One or more fields are invalid.");
    this.details = details;
  }
}

// Letters (incl. accented), joined by single hyphens, apostrophes or spaces: O'Brien, De La Cruz.
const NAME_RE = /^\p{L}+(?:[-' ]\p{L}+)*$/u;
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/** Basic sanitization: strip control characters, collapse whitespace. */
export function cleanText(value: unknown): string {
  return String(value).replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
}

export function validateName(value: unknown, label = "Name", maxLen = 50): string {
  const v = cleanText(value).replace(/\u2019/g, "'");
  if (v.length < 1 || v.length > maxLen) throw new Error(`${label} must be between 1 and ${maxLen} characters.`);
  if (!NAME_RE.test(v)) throw new Error(`${label} can only contain letters, hyphens and apostrophes.`);
  return v;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Accepts MM/DD/YYYY, YYYY-MM-DD or MM-DD-YYYY. Returns ISO YYYY-MM-DD. */
export function validateDob(value: unknown, now: Date = new Date()): string {
  const s = cleanText(value);
  let y: number;
  let m: number;
  let d: number;
  let match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    throw new Error("Date of birth must be a real date in MM/DD/YYYY format.");
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error("Date of birth must be a real date in MM/DD/YYYY format.");
  }
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  if (iso > today) throw new Error("Date of birth cannot be in the future.");
  if (y < now.getUTCFullYear() - 130) throw new Error("Date of birth is too far in the past to be valid.");
  return iso;
}

/** ISO YYYY-MM-DD -> MM/DD/YYYY (the API's display format). */
export function formatDob(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/** Returns the 10-digit form. Accepts (555) 123-4567, 555.123.4567, +1 555 123 4567, ... */
export function validateUsPhone(value: unknown, label = "Phone number"): string {
  let digits = String(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) throw new Error(`${label} must be a 10-digit U.S. number (got ${digits.length} digits).`);
  if ("01".includes(digits[0])) throw new Error(`${label} has an invalid area code; U.S. area codes cannot start with 0 or 1.`);
  return digits;
}

export function validateState(value: unknown): string {
  const v = cleanText(value);
  const code = v.toUpperCase().replace(/\./g, "");
  if (code in US_STATES) return code;
  const byName = STATE_BY_NAME[v.toLowerCase()]; // forgiving: "California" -> "CA"
  if (byName) return byName;
  throw new Error("State must be a valid 2-letter U.S. state abbreviation, like CA or NY.");
}

export function validateZip(value: unknown): string {
  let v = cleanText(value).replace(/ /g, "");
  if (/^\d{9}$/.test(v)) v = `${v.slice(0, 5)}-${v.slice(5)}`;
  if (!ZIP_RE.test(v)) throw new Error("ZIP code must be 5 digits, or ZIP+4 like 12345-6789.");
  return v;
}

const SEX_MAP: Record<string, Sex> = {
  male: "Male", m: "Male", man: "Male",
  female: "Female", f: "Female", woman: "Female",
  other: "Other", "non-binary": "Other", nonbinary: "Other",
  "decline to answer": "Decline to Answer", decline: "Decline to Answer",
  "prefer not to say": "Decline to Answer", "prefer not to answer": "Decline to Answer",
};

export function validateSex(value: unknown): Sex {
  const mapped = SEX_MAP[cleanText(value).toLowerCase()];
  if (!mapped) throw new Error("Sex must be one of: Male, Female, Other, or Decline to Answer.");
  return mapped;
}

export function validateEmail(value: unknown): string {
  const v = cleanText(value).toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) throw new Error("Email address is not in a valid format.");
  return v;
}

export function validateMemberId(value: unknown): string {
  const v = cleanText(value).replace(/[\s-]/g, "").toUpperCase();
  if (!v || v.length > 50 || !/^[A-Z0-9]+$/.test(v)) {
    throw new Error("Insurance member ID must be letters and numbers only (max 50).");
  }
  return v;
}

export function validateFreeText(value: unknown, label: string, maxLen: number): string {
  const v = cleanText(value);
  if (v.length < 1 || v.length > maxLen) throw new Error(`${label} must be between 1 and ${maxLen} characters.`);
  if (!/[A-Za-z0-9]/.test(v)) throw new Error(`${label} must contain letters or numbers.`);
  return v;
}

const FIELD_VALIDATORS: Record<PatientField, (v: unknown) => string> = {
  first_name: (v) => validateName(v, "First name"),
  last_name: (v) => validateName(v, "Last name"),
  date_of_birth: (v) => validateDob(v),
  sex: (v) => validateSex(v),
  phone_number: (v) => validateUsPhone(v),
  email: (v) => validateEmail(v),
  address_line_1: (v) => validateFreeText(v, "Street address", 200),
  address_line_2: (v) => validateFreeText(v, "Address line 2", 100),
  city: (v) => validateFreeText(v, "City", 100),
  state: (v) => validateState(v),
  zip_code: (v) => validateZip(v),
  insurance_provider: (v) => validateFreeText(v, "Insurance provider", 100),
  insurance_member_id: (v) => validateMemberId(v),
  preferred_language: (v) => validateName(v, "Preferred language"),
  emergency_contact_name: (v) => validateName(v, "Emergency contact name", 100),
  emergency_contact_phone: (v) => validateUsPhone(v, "Emergency contact phone"),
};

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/**
 * Validate a create (mode "create": required fields enforced, language defaults to English) or a
 * partial update (mode "update": only provided keys change; required fields may not be cleared;
 * optional fields may be cleared with null/""). Unknown fields are rejected.
 * Returns normalized values; `null` means "clear this optional field".
 */
export function validatePatient(
  input: unknown,
  mode: "create" | "update",
  opts: { ignoreUnknown?: boolean } = {},
): Record<string, string | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError([{ field: null, message: "Request body must be a JSON object." }]);
  }
  const errors: FieldError[] = [];
  const out: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(PATIENT_FIELDS as readonly string[]).includes(key)) {
      if (!opts.ignoreUnknown) errors.push({ field: key, message: "Unknown field." });
      continue;
    }
    const field = key as PatientField;
    if (isBlank(raw)) {
      if (mode === "update") out[field] = null;
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      errors.push({ field, message: "Must be a string." });
      continue;
    }
    try {
      out[field] = FIELD_VALIDATORS[field](raw);
    } catch (e) {
      errors.push({ field, message: (e as Error).message });
    }
  }
  if (mode === "create") {
    for (const f of REQUIRED_FIELDS) {
      if (out[f] === undefined && !errors.some((e) => e.field === f)) {
        errors.push({ field: f, message: "This field is required." });
      }
    }
    if (!out.preferred_language) out.preferred_language = "English";
  } else {
    for (const f of REQUIRED_FIELDS) {
      if (out[f] === null) errors.push({ field: f, message: "Required field cannot be empty." });
    }
    if (Object.keys(out).length === 0 && errors.length === 0) {
      errors.push({ field: null, message: "Provide at least one field to update." });
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
