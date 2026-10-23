import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/** Names of the modules installed here: every src/modules/<name>/module.ts(x). */
const installedModules = (): string[] =>
  readdirSync(join(ROOT, "src/modules"), { withFileTypes: true })
    .filter(
      entry =>
        entry.isDirectory() &&
        ["module.ts", "module.tsx"].some(file =>
          existsSync(join(ROOT, "src/modules", entry.name, file)),
        ),
    )
    .map(entry => entry.name);

/**
 * The mount points Viktor's `add_space_module` relies on. A module lands as
 * `src/modules/<name>/` with a `module.ts` default export; the registry
 * finds it, the entry chunk runs it, `<ModuleOutlet />` renders its UI.
 * These checks are text-based because Bun's test runner has no
 * `import.meta.glob` (a Vite feature the registry uses).
 *
 * `src/main.tsx` and `src/App.tsx` belong to the app, so a Space upgraded
 * from an older template keeps its own copies without the wiring; that is
 * only a failure once a module is installed and has nowhere to mount.
 */
describe("Spaces module mount points", () => {
  test("the registry discovers src/modules/<name>/module.ts eagerly", () => {
    const registry = read("src/modules/registry.ts");
    expect(registry).toContain('"./*/module.{ts,tsx}"');
    expect(registry).toContain("eager: true");
    expect(registry).toContain("export const modules");
    expect(existsSync(join(ROOT, "src/modules/types.ts"))).toBe(true);
  });

  test("an installed module has its mount points wired in the app shell", () => {
    const installed = installedModules();
    if (installed.length === 0) return; // nothing to mount yet
    // Failing here means this app's main.tsx/App.tsx predate modules: add
    // `import "./modules/registry";` to src/main.tsx, and in src/App.tsx
    // import ModuleOutlet from "./modules/ModuleOutlet" and render it once
    // next to <Toaster />, so the installed modules can run and show UI.
    expect(read("src/main.tsx")).toContain('import "./modules/registry";');
    const app = read("src/App.tsx");
    expect(app.match(/<ModuleOutlet \/>/g)?.length).toBe(1);
    expect(app).toContain('from "./modules/ModuleOutlet"');
  });

  test("the slideshow starter keeps the mount points", () => {
    const sharedPath = join(ROOT, "templates/slideshow/shared-files.json");
    if (!existsSync(sharedPath)) return; // a selected starter has no templates/
    const shared: string[] = JSON.parse(readFileSync(sharedPath, "utf8"));
    for (const relative of [
      "src/modules/types.ts",
      "src/modules/registry.ts",
      "src/modules/ModuleOutlet.tsx",
    ]) {
      expect(shared).toContain(relative);
    }
    const slideshowApp = read("templates/slideshow/src/App.tsx");
    expect(slideshowApp).toContain("<ModuleOutlet />");
    // Before the session gate, like the base template: a module's UI (the
    // install dialog) must show while the visitor is still signing in.
    expect(slideshowApp.indexOf("<ModuleOutlet />")).toBeLessThan(
      slideshowApp.indexOf("<SpaceSessionRequired>"),
    );
  });
});
