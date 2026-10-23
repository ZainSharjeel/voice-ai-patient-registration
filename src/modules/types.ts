import type { ComponentType } from "react";

/**
 * A Spaces module: an optional, versioned feature Viktor adds to a Space on
 * request (`add_space_module`), delivered as source under
 * `src/modules/<name>/` and registered by its `module.ts` default export.
 * The template owns this contract and `src/modules/registry.ts`; a module
 * owns everything in its own directory (see its `MODULE.md`).
 */
export type SpaceModule = {
  /** The registry name, equal to the directory name (`pwa-install`). */
  name: string;
  /**
   * Rendered once by `<ModuleOutlet />` inside the app's providers (theme,
   * toasts); for dialogs, banners and other UI a module shows on its own
   * terms. Omit for modules that only export hooks and helpers.
   */
  Outlet?: ComponentType;
};
