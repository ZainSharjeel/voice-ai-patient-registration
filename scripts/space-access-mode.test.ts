import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtAccessModePlugin,
  describeOverrides,
  descriptorBuildEnv,
  parseDescriptorAuth,
  servedAccessMode,
} from "./space-access-mode";

const descriptor = (auth: unknown) => JSON.stringify({ version: 1, auth });

describe("parseDescriptorAuth", () => {
  test("reads v2 modes and valid provider lists", () => {
    expect(parseDescriptorAuth(descriptor({ mode: "public" }))).toEqual({
      mode: "public",
    });
    expect(
      parseDescriptorAuth(
        descriptor({ mode: "authenticated", providers: ["viktor"] }),
      ),
    ).toEqual({ mode: "authenticated", providers: ["viktor"] });
  });

  test("drops an invalid provider list but keeps the mode", () => {
    for (const providers of [[], ["github"], ["viktor", "viktor"], "viktor"]) {
      expect(
        parseDescriptorAuth(descriptor({ mode: "authenticated", providers })),
      ).toEqual({ mode: "authenticated" });
    }
  });

  test("legacy, missing and invalid modes defer to the environment", () => {
    for (const text of [
      descriptor({ mode: "space_auth" }),
      descriptor({ mode: "viktor_auth" }),
      descriptor({ mode: null }),
      descriptor({}),
      JSON.stringify({ version: 1 }),
      "null",
      "{not json",
      "",
      null,
      undefined,
    ]) {
      expect(parseDescriptorAuth(text)).toBeNull();
    }
  });
});

describe("descriptorBuildEnv", () => {
  test("the descriptor overrides the mode .env.local was initialised with", () => {
    expect(
      descriptorBuildEnv(
        { mode: "public" },
        { VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated" },
      ),
    ).toEqual({ VITE_VIKTOR_SPACES_ACCESS_MODE: "public" });
  });

  test("platform deploy builds keep the mode they were given", () => {
    expect(
      descriptorBuildEnv(
        { mode: "public" },
        {
          VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
          VITE_VIKTOR_SPACES_ENVIRONMENT: "production",
        },
      ),
    ).toEqual({});
  });

  test("no usable descriptor changes nothing", () => {
    expect(
      descriptorBuildEnv(null, { VITE_VIKTOR_SPACES_ACCESS_MODE: "public" }),
    ).toEqual({});
  });

  test("authenticated takes the descriptor's providers", () => {
    expect(
      descriptorBuildEnv(
        { mode: "authenticated", providers: ["viktor"] },
        { VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["email_password"]' },
      ),
    ).toEqual({
      VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated",
      VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]',
    });
  });

  test("authenticated without providers keeps a valid env list", () => {
    expect(
      descriptorBuildEnv(
        { mode: "authenticated" },
        { VITE_VIKTOR_SPACES_AUTH_PROVIDERS: '["viktor"]' },
      ),
    ).toEqual({ VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated" });
  });

  test("flipping a public Space to authenticated replaces its empty provider list", () => {
    for (const providers of ["[]", undefined, "nope"]) {
      expect(
        descriptorBuildEnv(
          { mode: "authenticated" },
          { VITE_VIKTOR_SPACES_AUTH_PROVIDERS: providers },
        ).VITE_VIKTOR_SPACES_AUTH_PROVIDERS,
      ).toBe('["email_password","viktor"]');
    }
  });
});

describe("describeOverrides", () => {
  test("names only the values that change", () => {
    expect(
      describeOverrides(
        { VITE_VIKTOR_SPACES_ACCESS_MODE: "public" },
        { VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated" },
      ),
    ).toBe(
      "ℹ️  Following viktor.space.json: VITE_VIKTOR_SPACES_ACCESS_MODE=public (was authenticated)",
    );
    expect(
      describeOverrides(
        { VITE_VIKTOR_SPACES_ACCESS_MODE: "public" },
        { VITE_VIKTOR_SPACES_ACCESS_MODE: "public" },
      ),
    ).toBeNull();
  });
});

describe("servedAccessMode", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const authenticatedEnv = { VITE_VIKTOR_SPACES_ACCESS_MODE: "authenticated" };

  function buildWith(mode: string | undefined) {
    mkdirSync(join(root, "dist"), { recursive: true });
    const at = new Date(Date.now() - 10_000);
    writeFileSync(join(root, "dist", "index.html"), "x");
    utimesSync(join(root, "dist", "index.html"), at, at);
    const plugin = builtAccessModePlugin(root);
    plugin.configResolved({ env: { VITE_VIKTOR_SPACES_ACCESS_MODE: mode } });
    plugin.writeBundle();
  }

  test("follows the mode the bundle was built with, not the descriptor", () => {
    root = mkdtempSync(join(tmpdir(), "space-access-mode-"));
    writeFileSync(
      join(root, "viktor.space.json"),
      descriptor({ mode: "public" }),
    );
    buildWith("authenticated");
    expect(servedAccessMode(root, {})).toBe("authenticated");
    buildWith("public");
    expect(servedAccessMode(root, authenticatedEnv)).toBe("public");
  });

  test("without a record (pre-plugin vite.config.ts) the env decides", () => {
    root = mkdtempSync(join(tmpdir(), "space-access-mode-"));
    writeFileSync(
      join(root, "viktor.space.json"),
      descriptor({ mode: "public" }),
    );
    expect(servedAccessMode(root, authenticatedEnv)).toBe("authenticated");
  });

  test("a record older than dist/ is ignored", () => {
    root = mkdtempSync(join(tmpdir(), "space-access-mode-"));
    buildWith("public");
    writeFileSync(join(root, "dist", "index.html"), "rebuilt without plugin");
    const later = new Date(Date.now() + 10_000);
    utimesSync(join(root, "dist", "index.html"), later, later);
    expect(servedAccessMode(root, authenticatedEnv)).toBe("authenticated");
  });

  test("a build with no mode records none", () => {
    root = mkdtempSync(join(tmpdir(), "space-access-mode-"));
    buildWith(undefined);
    expect(servedAccessMode(root, authenticatedEnv)).toBe("authenticated");
  });
});
