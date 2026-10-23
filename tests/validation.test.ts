import { describe, expect, test } from "bun:test";
import {
  ValidationError, validateDob, validatePatient, validateSex, validateState, validateUsPhone, validateZip, validateName,
} from "../convex/validation";

const NOW = new Date("2026-10-23T12:00:00Z");

describe("field validators", () => {
  test("names allow letters, hyphens, apostrophes, spaces", () => {
    expect(validateName("O’Brien")).toBe("O'Brien");
    expect(validateName("Smith-Jones")).toBe("Smith-Jones");
    expect(validateName("José")).toBe("José");
    expect(() => validateName("J0hn")).toThrow();
    expect(() => validateName("a".repeat(51))).toThrow();
  });
  test("DOB: real, not future, normalized", () => {
    expect(validateDob("03/14/1985", NOW)).toBe("1985-03-14");
    expect(validateDob("1985-03-14", NOW)).toBe("1985-03-14");
    expect(() => validateDob("02/30/1990", NOW)).toThrow(/real date/);
    expect(() => validateDob("01/01/2027", NOW)).toThrow(/future/);
    expect(() => validateDob("1985/03/14", NOW)).toThrow();
  });
  test("US phone: 10 digits, optional +1, valid area code", () => {
    expect(validateUsPhone("(212) 555-0147")).toBe("2125550147");
    expect(validateUsPhone("+1 212.555.0147")).toBe("2125550147");
    expect(() => validateUsPhone("555-0147")).toThrow(/got 7 digits/);
    expect(() => validateUsPhone("0125550147")).toThrow(/area code/);
  });
  test("state, zip, sex normalization", () => {
    expect(validateState("california")).toBe("CA");
    expect(validateState("ny")).toBe("NY");
    expect(() => validateState("XX")).toThrow();
    expect(validateZip("123456789")).toBe("12345-6789");
    expect(() => validateZip("1234")).toThrow();
    expect(validateSex("woman")).toBe("Female");
    expect(() => validateSex("robot")).toThrow();
  });
});

describe("validatePatient", () => {
  const valid = {
    first_name: "John", last_name: "Smith", date_of_birth: "05/02/1990", sex: "Male", phone_number: "4155550123",
    address_line_1: "1 Market St", city: "San Francisco", state: "CA", zip_code: "94105",
  };
  test("create applies defaults", () => {
    expect(validatePatient(valid, "create").preferred_language).toBe("English");
  });
  test("create lists every missing/invalid field", () => {
    try {
      validatePatient({ first_name: "John" }, "create");
      throw new Error("expected failure");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details.map((d) => d.field)).toContain("zip_code");
    }
  });
  test("unknown fields rejected, required fields cannot be cleared on update", () => {
    expect(() => validatePatient({ ...valid, ssn: "123" }, "create")).toThrow(ValidationError);
    expect(() => validatePatient({ city: "" }, "update")).toThrow(ValidationError);
    expect(validatePatient({ email: "" }, "update")).toEqual({ email: null });
    expect(() => validatePatient({}, "update")).toThrow(ValidationError);
  });
});
