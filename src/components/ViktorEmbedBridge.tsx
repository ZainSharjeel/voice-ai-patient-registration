import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  annotationMessage,
  annotationRelay,
  isShellMessage,
  postToShell,
  readyMessage,
  routeMessage,
  safeAppPath,
  shellOrigin,
} from "@/lib/viktor-embed/bridge";

/** Window event the bridge raises when the shell sets the theme; the app's
 * ThemeProvider listens for it so its own state follows. */
export const EMBED_THEME_EVENT = "viktor-embed-theme";

/**
 * How long a location must hold before it is reported as the reader's route.
 * An arrival bounces through auth routes in quick succession (`/` → the
 * dashboard → `/login` while the session restores → the dashboard again);
 * only the route that settles is where the reader is, and the shell's
 * breadcrumb must not flash the ones in between.
 */
export const ROUTE_SETTLE_MS = 400;

/**
 * Talks to the Viktor dashboard when this Space is shown inside its
 * Knowledge sidebar (see `lib/viktor-embed/bridge.ts`). Renders nothing;
 * does nothing when the app is not framed.
 *
 * Mounted from the managed auth routes so the template upgrade tool carries
 * it into existing Spaces. `ready` is posted exactly once per document: the
 * mount effect does not depend on the router's `navigate`, whose identity
 * changes with every location.
 */
export function ViktorEmbedBridge() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const origin = useRef<string | null>(null);

  useEffect(() => {
    origin.current = shellOrigin();
    if (origin.current === null) return;
    const target = origin.current;
    postToShell(target, readyMessage());
    const annotations = annotationRelay(() =>
      import("@/lib/viktor-embed/annotations").then(module =>
        module.startAnnotationLayer({
          post: raised => postToShell(target, annotationMessage(raised)),
          navigate: path => navigateRef.current(path),
          route: () => `${window.location.pathname}${window.location.search}`,
        }),
      ),
    );

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== target || event.source !== window.parent) return;
      if (!isShellMessage(event.data)) return;
      if (event.data.type === "theme") {
        const root = document.documentElement;
        root.classList.toggle("dark", event.data.theme === "dark");
        window.dispatchEvent(
          new CustomEvent(EMBED_THEME_EVENT, { detail: event.data.theme }),
        );
        return;
      }
      if (event.data.type === "annotation") {
        annotations.receive(event.data.event);
        return;
      }
      const path = safeAppPath(event.data.path);
      if (path !== null) navigateRef.current(path);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      annotations.stop();
    };
    // Once per document, on purpose: see the component comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const target = origin.current;
    if (target === null) return;
    const path = `${location.pathname}${location.search}`;
    let observer: MutationObserver | null = null;
    const timer = setTimeout(() => {
      const send = () =>
        postToShell(target, routeMessage(path, document.title));
      // Titles settle after the route renders; report the route now and
      // again when the document title changes for it.
      send();
      const titleElement = document.querySelector("title");
      if (titleElement === null) return;
      observer = new MutationObserver(send);
      observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }, ROUTE_SETTLE_MS);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [location.pathname, location.search]);

  return null;
}
