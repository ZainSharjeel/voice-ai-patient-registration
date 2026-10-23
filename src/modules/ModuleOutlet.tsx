import { modules } from "./registry";

/**
 * Where installed modules render their UI. Mounted once in `App.tsx` (and in
 * the slideshow starter's `App.tsx`), inside the providers, so a module's
 * dialog or banner sees the theme and the toaster. Renders nothing while no
 * installed module has an `Outlet`.
 */
export function ModuleOutlet() {
  return (
    <>
      {modules.map(module =>
        module.Outlet ? <module.Outlet key={module.name} /> : null,
      )}
    </>
  );
}
