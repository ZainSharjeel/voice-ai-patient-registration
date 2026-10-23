import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildInputsStampPlugin } from "./build-inputs";
import {
  announcedPort,
  checkBuild,
  choosePreviewPort,
  isPortFree,
  PREFERRED_PREVIEW_PORT,
} from "./preview-server";

describe("checkBuild", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(relative: string, secondsAgo: number) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
    const at = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, at, at);
  }

  function project() {
    root = mkdtempSync(join(tmpdir(), "check-build-"));
    file("src/App.tsx", 100);
    file("convex/schema.ts", 100);
    file("convex/_generated/api.d.ts", 100);
    file("index.html", 100);
    file("dist/index.html", 50);
  }

  test("a build newer than every input is fresh", () => {
    project();
    expect(checkBuild(root)).toEqual({ fresh: true });
  });

  test("a frontend change after the build needs `build`", () => {
    project();
    file("src/pages/Home.tsx", 10);
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason: "src/pages/Home.tsx changed after the last build",
      script: "build",
    });
  });

  function recordBuild() {
    const plugin = buildInputsStampPlugin(root);
    plugin.buildStart();
    plugin.writeBundle();
  }

  test("a recorded build with an unchanged file set is fresh", () => {
    project();
    recordBuild();
    expect(checkBuild(root)).toEqual({ fresh: true });
  });

  test("a deleted source makes the build stale", () => {
    project();
    file("src/pages/Old.tsx", 100);
    recordBuild();
    rmSync(join(root, "src/pages/Old.tsx"));
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason:
        "source files were added, removed or renamed since the last build",
      script: "build",
    });
  });

  test("a renamed source (mtime kept) makes the build stale", () => {
    project();
    file("src/pages/Old.tsx", 100);
    recordBuild();
    renameSync(
      join(root, "src/pages/Old.tsx"),
      join(root, "src/pages/New.tsx"),
    );
    expect(checkBuild(root)).toMatchObject({ fresh: false, script: "build" });
  });

  test.each([
    "delete",
    "rename",
  ] as const)("a src/ edit plus a Convex module %s needs `sync:build`", change => {
    project();
    file("convex/tasks.ts", 100);
    recordBuild();
    const tasks = join(root, "convex/tasks.ts");
    if (change === "delete") rmSync(tasks);
    else renameSync(tasks, join(root, "convex/todos.ts"));
    file("src/pages/Home.tsx", 10);
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason:
        "files under convex/ were added, removed or renamed since the last build",
      script: "sync:build",
    });
  });

  test("a deleted Convex module needs `sync:build`", () => {
    project();
    file("convex/tasks.ts", 100);
    recordBuild();
    rmSync(join(root, "convex/tasks.ts"));
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason:
        "files under convex/ were added, removed or renamed since the last build",
      script: "sync:build",
    });
  });

  test("without a recorded file set, only mtimes count", () => {
    project();
    file("src/pages/Old.tsx", 100);
    rmSync(join(root, "src/pages/Old.tsx"));
    expect(checkBuild(root)).toEqual({ fresh: true });
  });

  test.each([
    "scripts/space-access-mode.ts",
    "scripts/build-inputs.ts",
  ])("a change to %s, which vite.config.ts imports, needs `build`", script => {
    project();
    file(script, 10);
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason: `${script} changed after the last build`,
      script: "build",
    });
  });

  test("a descriptor change after the build needs `build`", () => {
    project();
    file("viktor.space.json", 10);
    expect(checkBuild(root)).toMatchObject({ fresh: false, script: "build" });
  });

  test("a Convex change after the build needs `sync:build`", () => {
    project();
    file("convex/tasks.ts", 10);
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason: "convex/tasks.ts changed after the last build",
      script: "sync:build",
    });
  });

  test("codegen output and node_modules do not count as changes", () => {
    project();
    file("convex/_generated/api.d.ts", 1);
    file("src/node_modules/pkg/index.js", 1);
    expect(checkBuild(root)).toEqual({ fresh: true });
  });

  test("no build yet: `build` after codegen, `sync:build` before it", () => {
    project();
    rmSync(join(root, "dist"), { recursive: true });
    expect(checkBuild(root)).toEqual({
      fresh: false,
      reason: "dist/ has no build",
      script: "build",
    });
    rmSync(join(root, "convex", "_generated"), { recursive: true });
    expect(checkBuild(root)).toMatchObject({ script: "sync:build" });
  });

  describe("without dist/", () => {
    function backdateRecord(secondsAgo: number) {
      const at = new Date(Date.now() - secondsAgo * 1000);
      utimesSync(join(root, "tmp", "build-inputs.json"), at, at);
    }

    test("a Convex change after codegen needs `sync:build`", () => {
      project();
      rmSync(join(root, "dist"), { recursive: true });
      file("convex/tasks.ts", 10);
      expect(checkBuild(root)).toEqual({
        fresh: false,
        reason: "dist/ has no build",
        script: "sync:build",
      });
    });

    test("a Convex change after the last recorded build needs `sync:build`", () => {
      project();
      recordBuild();
      backdateRecord(50);
      rmSync(join(root, "dist"), { recursive: true });
      file("convex/schema.ts", 10);
      expect(checkBuild(root)).toMatchObject({ script: "sync:build" });
    });

    test("a deleted Convex module since the last recorded build needs `sync:build`", () => {
      project();
      file("convex/tasks.ts", 100);
      recordBuild();
      rmSync(join(root, "dist"), { recursive: true });
      rmSync(join(root, "convex/tasks.ts"));
      expect(checkBuild(root)).toMatchObject({ script: "sync:build" });
    });

    test("only frontend changes since the last recorded build need `build`", () => {
      project();
      recordBuild();
      backdateRecord(50);
      rmSync(join(root, "dist"), { recursive: true });
      file("src/pages/Home.tsx", 10);
      expect(checkBuild(root)).toMatchObject({ script: "build" });
    });
  });
});

describe("choosePreviewPort", () => {
  test("keeps the preferred port when it is free", async () => {
    expect(await choosePreviewPort(async () => true)).toBe(
      PREFERRED_PREVIEW_PORT,
    );
  });

  test("falls back to the next free port when the preferred one is held", async () => {
    const held = new Set([PREFERRED_PREVIEW_PORT, PREFERRED_PREVIEW_PORT + 1]);
    expect(await choosePreviewPort(async port => !held.has(port))).toBe(
      PREFERRED_PREVIEW_PORT + 2,
    );
  });

  test("skips ports already tried", async () => {
    expect(
      await choosePreviewPort(
        async () => true,
        new Set([PREFERRED_PREVIEW_PORT]),
      ),
    ).toBe(PREFERRED_PREVIEW_PORT + 1);
  });

  test("fails loudly when no port in range is free", async () => {
    await expect(choosePreviewPort(async () => false)).rejects.toThrow(
      /No free preview port/,
    );
  });
});

describe("isPortFree", () => {
  let holder: Server | undefined;
  afterEach(async () => {
    await new Promise(done => (holder ? holder.close(done) : done(undefined)));
    holder = undefined;
  });

  test("reports a port held on IPv4 loopback as taken", async () => {
    holder = createServer();
    const port = await new Promise<number>(done =>
      holder!.listen(0, "127.0.0.1", () => {
        const address = holder!.address();
        done(typeof address === "object" && address ? address.port : 0);
      }),
    );
    expect(await isPortFree(port)).toBe(false);
    await new Promise(done => holder!.close(done));
    holder = undefined;
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("announcedPort", () => {
  test("reads the port from vite's Local banner", () => {
    expect(
      announcedPort(
        "$ vite preview\n  ➜  Local:   http://localhost:4174/\n  ➜  Network: use --host",
      ),
    ).toBe(4174);
    expect(announcedPort("  ➜  Local:   http://127.0.0.1:4175/")).toBe(4175);
  });

  test("ignores ANSI colors", () => {
    const esc = String.fromCharCode(27);
    expect(
      announcedPort(
        `  ➜  ${esc}[1mLocal${esc}[22m:   ${esc}[36mhttp://localhost:${esc}[1m4180${esc}[22m/${esc}[39m`,
      ),
    ).toBe(4180);
  });

  test("returns null before vite has bound a port", () => {
    expect(announcedPort("$ vite preview --port 4173 --strictPort")).toBeNull();
  });
});
