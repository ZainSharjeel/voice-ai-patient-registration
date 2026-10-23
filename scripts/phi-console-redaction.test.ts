/**
 * Unit tests for the PHI console redaction shim (convex/phiLogging.ts) and
 * the static-message extraction that feeds its allowlist
 * (scripts/generate-phi-console-statics.ts).
 *
 * Run with: bun test scripts/phi-console-redaction.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installPhiConsoleShim,
  PHI_MODE_ENV_VAR,
  PHI_REDACTED,
  phiModeEnabled,
  sanitizeConsoleArgsPhi,
  sanitizedErrorPhi,
  sanitizeTimerLabelPhi,
  sanitizeValuePhi,
} from "../convex/phiLogging";
import {
  extractConsoleStaticMessages,
  renderStaticsModule,
} from "./generate-phi-console-statics";

const STATICS = new Set(["saved record", "timer label"]);

describe("sanitizeValuePhi", () => {
  test("keeps scalars that cannot carry PHI", () => {
    expect(sanitizeValuePhi(null)).toBe(null);
    expect(sanitizeValuePhi(undefined)).toBe(undefined);
    expect(sanitizeValuePhi(true)).toBe(true);
    expect(sanitizeValuePhi(42)).toBe(42);
    expect(sanitizeValuePhi(7n)).toBe(7n);
  });

  test("redacts strings, objects, and arrays wholesale", () => {
    expect(sanitizeValuePhi("patient chart for John Doe")).toBe(PHI_REDACTED);
    expect(sanitizeValuePhi({ diagnosis: "details" })).toBe(PHI_REDACTED);
    expect(sanitizeValuePhi(["John", "Doe"])).toBe(PHI_REDACTED);
  });

  test("keeps error frames but redacts the message", () => {
    const error = new Error("PHI in the exception message");
    const sanitized = sanitizeValuePhi(error) as string;
    expect(sanitized).not.toContain("PHI in the exception message");
    expect(sanitized).toContain("Error");
    expect(sanitized).toContain(PHI_REDACTED);
    expect(sanitized).toContain(" at ");
  });
});

describe("sanitizedErrorPhi", () => {
  test("handles errors without a stack", () => {
    const error = new Error("secret detail");
    error.stack = undefined;
    expect(sanitizedErrorPhi(error)).toBe(`Error: ${PHI_REDACTED}`);
  });

  test("keeps the error subclass name", () => {
    const error = new TypeError("secret detail");
    const sanitized = sanitizedErrorPhi(error);
    expect(sanitized).toContain("TypeError");
    expect(sanitized).not.toContain("secret detail");
  });
});

describe("sanitizeConsoleArgsPhi", () => {
  test("keeps a static message and scalar arguments", () => {
    expect(
      sanitizeConsoleArgsPhi(["saved record", 7, true, null], STATICS),
    ).toEqual(["saved record", 7, true, null]);
  });

  test("redacts a message built at runtime", () => {
    const name = "John Doe";
    const [message] = sanitizeConsoleArgsPhi([`saved record ${name}`], STATICS);
    expect(message).toBe(`<dynamic message> ${PHI_REDACTED}`);
  });

  test("redacts non-message string and object arguments", () => {
    expect(
      sanitizeConsoleArgsPhi(
        ["saved record", "John Doe", { email: "j@x.com" }],
        STATICS,
      ),
    ).toEqual(["saved record", PHI_REDACTED, PHI_REDACTED]);
  });

  test("a non-string first argument goes through the value rules", () => {
    expect(sanitizeConsoleArgsPhi([42], STATICS)).toEqual([42]);
    expect(sanitizeConsoleArgsPhi([{ a: 1 }], STATICS)).toEqual([PHI_REDACTED]);
  });

  test("is output-idempotent", () => {
    const once = sanitizeConsoleArgsPhi([`dynamic ${Date.now()}`], STATICS);
    expect(sanitizeConsoleArgsPhi(once, STATICS)).toEqual(once);
  });
});

describe("sanitizeTimerLabelPhi", () => {
  test("keeps static labels and redacts dynamic ones", () => {
    expect(sanitizeTimerLabelPhi("timer label", STATICS)).toBe("timer label");
    expect(sanitizeTimerLabelPhi("load patient-42", STATICS)).toBe(
      PHI_REDACTED,
    );
  });
});

describe("installPhiConsoleShim", () => {
  function fakeConsole() {
    const calls: Record<string, unknown[][]> = {};
    const target: Record<string, unknown> = {};
    for (const method of [
      "debug",
      "log",
      "info",
      "warn",
      "error",
      "trace",
      "time",
      "timeEnd",
      "timeLog",
    ]) {
      calls[method] = [];
      target[method] = (...args: unknown[]) => {
        calls[method].push(args);
      };
    }
    return { target, calls };
  }

  test("sanitizes every logging method", () => {
    const { target, calls } = fakeConsole();
    installPhiConsoleShim(target, STATICS);
    for (const method of ["debug", "log", "info", "warn", "error", "trace"]) {
      (target[method] as (...args: unknown[]) => void)(
        "saved record",
        "John Doe",
        3,
      );
      expect(calls[method]).toEqual([["saved record", PHI_REDACTED, 3]]);
    }
  });

  test("sanitizes error objects passed to console.error", () => {
    const { target, calls } = fakeConsole();
    installPhiConsoleShim(target, STATICS);
    (target.error as (...args: unknown[]) => void)(
      new Error("chart for John Doe"),
    );
    const [[sanitized]] = calls.error as [[string]];
    expect(sanitized).not.toContain("John Doe");
    expect(sanitized).toContain(PHI_REDACTED);
  });

  test("sanitizes timer labels", () => {
    const { target, calls } = fakeConsole();
    installPhiConsoleShim(target, STATICS);
    (target.time as (label?: unknown) => void)("timer label");
    (target.timeEnd as (label?: unknown) => void)("patient-42");
    (target.time as (label?: unknown) => void)();
    expect(calls.time).toEqual([["timer label"], []]);
    expect(calls.timeEnd).toEqual([[PHI_REDACTED]]);
  });
});

describe("phiModeEnabled", () => {
  test("follows the deployment env var", () => {
    const previous = process.env[PHI_MODE_ENV_VAR];
    try {
      delete process.env[PHI_MODE_ENV_VAR];
      expect(phiModeEnabled()).toBe(false);
      process.env[PHI_MODE_ENV_VAR] = "true";
      expect(phiModeEnabled()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[PHI_MODE_ENV_VAR];
      } else {
        process.env[PHI_MODE_ENV_VAR] = previous;
      }
    }
  });
});

describe("extractConsoleStaticMessages", () => {
  test("collects literal and substitution-free template messages", () => {
    const source = `
      console.log("plain literal", record);
      console.error(\`template literal\`);
      console.time("timer literal");
      function nested() {
        console.warn("nested literal");
      }
    `;
    expect(extractConsoleStaticMessages(source).sort()).toEqual([
      "nested literal",
      "plain literal",
      "template literal",
      "timer literal",
    ]);
  });

  test("skips runtime-built and non-console messages", () => {
    const source = `
      const name = "John";
      console.log(\`hello \${name}\`);
      console.log(name);
      console.log("a" + "b");
      console.log(record);
      logger.log("not the console");
      console.custom("unknown method");
    `;
    expect(extractConsoleStaticMessages(source)).toEqual([]);
  });
});

describe("cross-language PHI redaction contract", () => {
  // Shared policy fixture, also asserted by the backend logger's tests
  // (backend/viktor/utils/tests/test_phi_log_sanitization.py). Drift in
  // either implementation fails that side's CI against this file.
  const contract = JSON.parse(
    readFileSync(join(import.meta.dir, "phi-redaction-contract.json"), "utf8"),
  ) as {
    sentinel: string;
    dynamic_message_replacement: string;
    pass_through_values: unknown[];
    redacted_values: unknown[];
    error_contract: { message: string };
  };

  test("the sentinel matches the contract", () => {
    expect(PHI_REDACTED).toBe(contract.sentinel);
  });

  test("contract pass-through values survive unchanged", () => {
    for (const value of contract.pass_through_values) {
      expect(sanitizeValuePhi(value)).toBe(value);
    }
  });

  test("contract redacted values become the sentinel", () => {
    for (const value of contract.redacted_values) {
      expect(sanitizeValuePhi(value)).toBe(contract.sentinel);
    }
  });

  test("runtime-built messages become the contract replacement", () => {
    const [message] = sanitizeConsoleArgsPhi(
      [`built at runtime ${Date.now()}`],
      new Set<string>(),
    );
    expect(message).toBe(contract.dynamic_message_replacement);
  });

  test("error type survives, error message never does", () => {
    const sanitized = sanitizedErrorPhi(
      new TypeError(contract.error_contract.message),
    );
    expect(sanitized).toContain("TypeError");
    expect(sanitized).toContain(contract.sentinel);
    expect(sanitized).not.toContain(contract.error_contract.message);
  });
});

describe("renderStaticsModule", () => {
  test("writes sorted unique entries", () => {
    const rendered = renderStaticsModule(["b", "a", "b"]);
    expect(rendered).toContain('  "a",\n  "b",');
    expect(rendered).toContain("PHI_CONSOLE_STATIC_MESSAGES: string[] = [");
  });

  test("the empty rendering matches the checked-in template file", () => {
    const checkedIn = readFileSync(
      join(import.meta.dir, "..", "convex", "phiConsoleStatics.ts"),
      "utf8",
    );
    expect(renderStaticsModule([])).toBe(checkedIn);
  });
});
