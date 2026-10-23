/**
 * Unit tests for the PHI authenticated-functions deploy check
 * (scripts/check-phi-authenticated-functions.ts): raw `query` / `mutation` /
 * `action` registrations from "./_generated/server" are flagged, code using
 * the template's authenticated builders from "./functions" passes.
 *
 * Run with: bun test scripts/phi-authenticated-functions.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_ROOT_MODULES,
  checkConvexDir,
  findRawRegistrations,
  isAllowedRootModule,
} from "./check-phi-authenticated-functions";

describe("findRawRegistrations", () => {
  test("flags a raw query registration from ./_generated/server", () => {
    const violations = findRawRegistrations(`
      import { query } from "./_generated/server";
      export const listRecords = query({
        args: {},
        handler: async ctx => ctx.db.query("records").collect(),
      });
    `);
    expect(violations).toEqual([
      { registrar: "query", localName: "query", line: 3 },
    ]);
  });

  test("passes code using the authenticated builders from ./functions", () => {
    const violations = findRawRegistrations(`
      import { v } from "convex/values";
      import {
        authenticatedAction,
        authenticatedMutation,
        authenticatedQuery,
      } from "./functions";
      export const listRecords = authenticatedQuery({
        args: {},
        handler: async ctx => ctx.db.query("records").collect(),
      });
      export const addRecord = authenticatedMutation({
        args: { title: v.string() },
        handler: async (ctx, args) => ctx.db.insert("records", args),
      });
      export const syncRecords = authenticatedAction({
        args: {},
        handler: async () => {},
      });
    `);
    expect(violations).toEqual([]);
  });

  test("flags mutation and action registrations too", () => {
    const violations = findRawRegistrations(`
      import { action, mutation } from "./_generated/server";
      export const addRecord = mutation({ handler: async () => {} });
      export const syncRecords = action({ handler: async () => {} });
    `);
    expect(violations.map(v => v.registrar)).toEqual(["mutation", "action"]);
  });

  test("flags aliased imports", () => {
    const violations = findRawRegistrations(`
      import { query as rawQuery } from "./_generated/server";
      export const listRecords = rawQuery({ handler: async () => {} });
    `);
    expect(violations).toEqual([
      { registrar: "query", localName: "rawQuery", line: 3 },
    ]);
  });

  test("flags namespace-import registrations", () => {
    const violations = findRawRegistrations(`
      import * as server from "./_generated/server";
      export const listRecords = server.query({ handler: async () => {} });
    `);
    expect(violations).toEqual([
      { registrar: "query", localName: "server.query", line: 3 },
    ]);
  });

  test("flags imports from ../_generated/server in subdirectory files", () => {
    const violations = findRawRegistrations(`
      import { query } from "../_generated/server";
      export const listRecords = query({ handler: async () => {} });
    `);
    expect(violations.map(v => v.registrar)).toEqual(["query"]);
  });

  test("does not flag internal builders", () => {
    const violations = findRawRegistrations(`
      import {
        internalAction,
        internalMutation,
        internalQuery,
      } from "./_generated/server";
      export const backfill = internalMutation({ handler: async () => {} });
      export const audit = internalQuery({ handler: async () => {} });
      export const sweep = internalAction({ handler: async () => {} });
    `);
    expect(violations).toEqual([]);
  });

  test("does not flag `query` imported from other modules", () => {
    const violations = findRawRegistrations(`
      import { query } from "./myHelpers";
      export const listRecords = query({ handler: async () => {} });
    `);
    expect(violations).toEqual([]);
  });
});

describe("isAllowedRootModule", () => {
  // Pinned: the template's audited root plumbing, and nothing else.
  test("allows exactly the template's own root modules", () => {
    expect([...ALLOWED_ROOT_MODULES].sort()).toEqual([
      "auth.ts",
      "functions.ts",
      "http.ts",
    ]);
    for (const name of ALLOWED_ROOT_MODULES) {
      expect(isAllowedRootModule(name)).toBe(true);
    }
  });

  test("does not allow the same names in subdirectories", () => {
    expect(isAllowedRootModule(join("records", "functions.ts"))).toBe(false);
    expect(isAllowedRootModule(join("records", "auth.ts"))).toBe(false);
    expect(isAllowedRootModule("records.ts")).toBe(false);
  });
});

describe("checkConvexDir", () => {
  test("reports raw registrations outside allowlisted root modules", () => {
    const convexDir = mkdtempSync(join(tmpdir(), "phi-fn-check-"));
    writeFileSync(
      join(convexDir, "functions.ts"),
      `import { query } from "./_generated/server";
       export const whoami = query({ handler: async () => null });`,
    );
    writeFileSync(
      join(convexDir, "records.ts"),
      `import { query } from "./_generated/server";
       export const listRecords = query({ handler: async () => {} });`,
    );
    writeFileSync(
      join(convexDir, "clean.ts"),
      `import { authenticatedQuery } from "./functions";
       export const listClean = authenticatedQuery({ handler: async () => {} });`,
    );
    mkdirSync(join(convexDir, "_generated"));
    writeFileSync(
      join(convexDir, "_generated", "server.ts"),
      `import { query } from "./raw";
       export const ignored = query({});`,
    );
    const violations = checkConvexDir(convexDir);
    expect(violations).toEqual([
      { registrar: "query", localName: "query", line: 2, file: "records.ts" },
    ]);
  });

  test("the template's own convex/ source passes", () => {
    const convexDir = join(import.meta.dir, "..", "convex");
    expect(checkConvexDir(convexDir)).toEqual([]);
  });
});
