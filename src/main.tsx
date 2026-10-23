import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import "@fontsource-variable/public-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
// Side-effect import, in the entry chunk on purpose: installed modules
// (src/modules/<name>/) run their entry code before the lazy route chunks
// mount. See src/modules/registry.ts.
import "./modules/registry";

// After a redeploy, a tab opened on the old build requests lazy chunks that
// no longer exist. Reload once to pick up the new build; a second failure
// within the window is a real error and reaches the error boundary.
const CHUNK_RELOAD_KEY = "viktor:chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 60_000;
window.addEventListener("vite:preloadError", event => {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY));
    if (Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
