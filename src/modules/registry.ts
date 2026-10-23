import type { SpaceModule } from "./types";

/**
 * Every installed module, found by convention: `src/modules/<name>/module.ts`
 * (or `.tsx`) default-exports its `SpaceModule`. Eager on purpose, and
 * imported for its side effects from `src/main.tsx`: a module's entry code
 * then runs in the entry chunk, before the lazily loaded route chunks mount
 * (the `pwa-install` module captures Chromium's one-shot
 * `beforeinstallprompt` there, which fires once per page load). Adding or
 * removing a module is adding or removing its directory; nothing here
 * changes. Sorted by name so the render order is stable.
 */
const entries = import.meta.glob<{ default: SpaceModule }>(
  "./*/module.{ts,tsx}",
  { eager: true },
);

export const modules: readonly SpaceModule[] = Object.keys(entries)
  .sort()
  .map(path => entries[path].default)
  .filter((module): module is SpaceModule => module !== undefined);
