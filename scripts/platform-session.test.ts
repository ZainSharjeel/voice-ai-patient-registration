import { describe, expect, test } from "bun:test";
import {
  isPlatformSessionEmail,
  isPlatformSessionUser,
  isPlatformSessionUserId,
  PLATFORM_SESSION_PROVIDER,
  platformSessionEmail,
} from "../convex/platformSession";

describe("platform session identity", () => {
  test("the minted email is recognised as a platform session", () => {
    const email = platformSessionEmail("user_123");
    expect(email).toBe("space-session-user_123@viktor.invalid");
    expect(isPlatformSessionEmail(email)).toBe(true);
    expect(isPlatformSessionUser({ email })).toBe(true);
  });

  test("matching ignores case and surrounding whitespace", () => {
    expect(isPlatformSessionEmail(" Space-Session-X@VIKTOR.INVALID ")).toBe(
      true,
    );
  });

  test("real and look-alike addresses are people", () => {
    for (const email of [
      "owner@company.com",
      "space-session-1@viktor.ai",
      "someone@viktor.invalid.example.com",
      "",
      null,
      undefined,
    ]) {
      expect(isPlatformSessionEmail(email)).toBe(false);
    }
    expect(isPlatformSessionUser(null)).toBe(false);
    expect(isPlatformSessionUser({})).toBe(false);
  });
});

describe("isPlatformSessionUserId", () => {
  interface Row {
    userId: string;
    provider: string;
  }

  function fakeDb(accounts: Row[], users: Record<string, { email?: string }>) {
    const lookups: Array<Record<string, string>> = [];
    const db = {
      query: (table: string) => {
        expect(table).toBe("authAccounts");
        return {
          withIndex: (
            index: string,
            range: (q: unknown) => unknown,
          ): { first: () => Promise<Row | null> } => {
            expect(index).toBe("userIdAndProvider");
            const fields: Record<string, string> = {};
            const q = {
              eq: (field: string, value: string) => {
                fields[field] = value;
                return q;
              },
            };
            range(q);
            lookups.push(fields);
            return {
              first: async () =>
                accounts.find(
                  row =>
                    row.userId === fields.userId &&
                    row.provider === fields.provider,
                ) ?? null,
            };
          },
        };
      },
      get: async (id: string) => users[id] ?? null,
    };
    return {
      db: db as unknown as Parameters<typeof isPlatformSessionUserId>[0],
      lookups,
    };
  }

  const id = (value: string) =>
    value as Parameters<typeof isPlatformSessionUserId>[1];

  test("a space_session account marks the user, whatever its email says", async () => {
    const { db, lookups } = fakeDb(
      [{ userId: "u1", provider: PLATFORM_SESSION_PROVIDER }],
      { u1: { email: "renamed@company.com" } },
    );
    expect(await isPlatformSessionUserId(db, id("u1"))).toBe(true);
    expect(lookups).toEqual([{ userId: "u1", provider: "space_session" }]);
  });

  test("the synthetic email still marks a user without the account row", async () => {
    const { db } = fakeDb([], {
      u2: { email: platformSessionEmail("viktor_9") },
    });
    expect(await isPlatformSessionUserId(db, id("u2"))).toBe(true);
  });

  test("people with other providers are not platform users", async () => {
    const { db } = fakeDb([{ userId: "u3", provider: "password" }], {
      u3: { email: "owner@company.com" },
    });
    expect(await isPlatformSessionUserId(db, id("u3"))).toBe(false);
    expect(await isPlatformSessionUserId(db, id("missing"))).toBe(false);
  });
});
