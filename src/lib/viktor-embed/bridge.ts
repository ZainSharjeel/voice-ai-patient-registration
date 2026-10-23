/**
 * The embed bridge: what a Space says to the Viktor app framing it.
 *
 * The Knowledge sidebar in the Viktor dashboard shows a Space inside an
 * iframe. The frame is a separate browsing context, so the shell around it
 * cannot see whether the app has mounted (or is stuck on a sign-in redirect),
 * which route the reader is on, or what to show in its breadcrumb; and the
 * app cannot see the reader's theme. Both sides speak `postMessage` in the
 * envelopes below — pinned by the dashboard's `knowledge-bridge.ts` — so keep
 * the literals in step when either changes.
 *
 * Frame → shell:  `ready` once the app has mounted, with the `features` the
 *                 frame speaks (`annotations`); `route` on every
 *                 client-side route change (`path` app-relative, `title`
 *                 the document title when there is one); `annotation`
 *                 carrying an event of the annotation layer.
 * Shell → frame:  `theme` on `ready` and whenever the reader's theme changes;
 *                 `navigate` to move the app to a route (breadcrumb clicks);
 *                 `annotation` carrying an event for the annotation layer,
 *                 whose `viktor:annotation:configure` starts it (see
 *                 `annotations.ts`).
 *
 * Nothing here runs outside a frame (`window.self !== window.top`), and
 * messages travel only between the frame and the origin that framed it:
 * outbound posts target the shell's origin, inbound envelopes are accepted
 * only from the parent window at that origin. The shell's origin is learned
 * once and kept for the tab: from the frame URL's `#viktor-shell=<origin>`
 * (the shell may set it), else from the referrer of the first entry (the
 * gate's strip redirect preserves it at origin granularity), and remembered
 * in `sessionStorage` so a reload or a full-page navigation inside the frame
 * — where the referrer is gone — still talks to the shell. A Space framed by
 * a page whose origin cannot be learned is silent.
 */

export const EMBED_MESSAGE_SOURCE = "viktor-embed";
export const SHELL_MESSAGE_SOURCE = "viktor-shell";
export const EMBED_BRIDGE_VERSION = 1;

export type EmbedTheme = "light" | "dark";

export const EMBED_FEATURES = ["annotations"] as const;
export const ANNOTATION_CONFIGURE = "viktor:annotation:configure";

export type AnnotationEvent = { type: string } & Record<string, unknown>;

export type EmbedToShellMessage =
  | {
      source: typeof EMBED_MESSAGE_SOURCE;
      version: 1;
      type: "ready";
      features: readonly string[];
    }
  | {
      source: typeof EMBED_MESSAGE_SOURCE;
      version: 1;
      type: "route";
      path: string;
      title?: string;
    }
  | {
      source: typeof EMBED_MESSAGE_SOURCE;
      version: 1;
      type: "annotation";
      event: AnnotationEvent;
    };

export type ShellToEmbedMessage =
  | {
      source: typeof SHELL_MESSAGE_SOURCE;
      version: 1;
      type: "theme";
      theme: EmbedTheme;
    }
  | {
      source: typeof SHELL_MESSAGE_SOURCE;
      version: 1;
      type: "navigate";
      path: string;
    }
  | {
      source: typeof SHELL_MESSAGE_SOURCE;
      version: 1;
      type: "annotation";
      event: AnnotationEvent;
    };

/** Fragment parameter carrying the shell's origin across cross-document navigations. */
export const SHELL_ORIGIN_PARAM = "viktor-shell";
/** `sessionStorage` key the shell's origin is remembered under for the tab. */
export const SHELL_ORIGIN_STORAGE_KEY = "viktor-embed:shell-origin";

/** What the origin resolution reads; the live window is the default, tests pass their own. */
export type EmbedEnvironment = {
  framed: boolean;
  ownOrigin: string;
  hash: string;
  referrer: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
};

function liveEnvironment(): EmbedEnvironment | null {
  if (typeof window === "undefined") return null;
  let storage: EmbedEnvironment["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Storage access can throw (sandboxed or privacy modes); the origin then
    // lives only for this document.
  }
  return {
    framed: window.self !== window.top,
    ownOrigin: window.location.origin,
    hash: window.location.hash,
    referrer: document.referrer,
    storage,
  };
}

function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The shell origin a frame URL fragment carries (`#viktor-shell=<origin>`, alone or after `&`). */
export function shellOriginFromHash(hash: string): string | null {
  const match = new RegExp(`(?:^#|&)${SHELL_ORIGIN_PARAM}=([^&]*)`).exec(hash);
  if (match === null) return null;
  try {
    return originOf(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/**
 * The origin of the dashboard framing this document, or null when there is
 * none to talk to. Framed-ness comes from the window tree, never from the
 * referrer. The origin comes from the fragment, else the referrer of this
 * entry (a framing page on our own origin is not the dashboard shell), else
 * what an earlier document in this tab remembered; whatever is found is
 * remembered for the next document.
 */
export function resolveShellOrigin(env: EmbedEnvironment): string | null {
  if (!env.framed) return null;
  const fromReferrer = env.referrer ? originOf(env.referrer) : null;
  const origin =
    shellOriginFromHash(env.hash) ??
    (fromReferrer !== null && fromReferrer !== env.ownOrigin
      ? fromReferrer
      : null) ??
    readStoredShellOrigin(env.storage);
  if (origin !== null && env.storage !== null) {
    try {
      env.storage.setItem(SHELL_ORIGIN_STORAGE_KEY, origin);
    } catch {
      // Quota or privacy refusal: the origin lives only for this document.
    }
  }
  return origin;
}

function readStoredShellOrigin(
  storage: EmbedEnvironment["storage"],
): string | null {
  if (storage === null) return null;
  try {
    const stored = storage.getItem(SHELL_ORIGIN_STORAGE_KEY);
    return stored ? originOf(stored) : null;
  } catch {
    return null;
  }
}

/** The origin of the page framing this one, or null when there is none to talk to. */
export function shellOrigin(): string | null {
  const env = liveEnvironment();
  return env === null ? null : resolveShellOrigin(env);
}

/** App-relative path (`/route?query`) the shell may navigate to; null for anything else. */
export function safeAppPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return null;
  if (value.includes("\\") || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value, "https://embed.local");
    if (url.origin !== "https://embed.local") return null;
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return null;
  }
}

export function isShellMessage(data: unknown): data is ShellToEmbedMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (
    message.source !== SHELL_MESSAGE_SOURCE ||
    message.version !== EMBED_BRIDGE_VERSION
  ) {
    return false;
  }
  if (message.type === "theme")
    return message.theme === "light" || message.theme === "dark";
  if (message.type === "navigate") return typeof message.path === "string";
  if (message.type === "annotation") return isAnnotationEvent(message.event);
  return false;
}

export function isAnnotationEvent(value: unknown): value is AnnotationEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && type.startsWith("viktor:annotation:");
}

export function readyMessage(): EmbedToShellMessage {
  return {
    source: EMBED_MESSAGE_SOURCE,
    version: EMBED_BRIDGE_VERSION,
    type: "ready",
    features: EMBED_FEATURES,
  };
}

export function annotationMessage(event: AnnotationEvent): EmbedToShellMessage {
  return {
    source: EMBED_MESSAGE_SOURCE,
    version: EMBED_BRIDGE_VERSION,
    type: "annotation",
    event,
  };
}

export type AnnotationReceiver = {
  receive: (event: AnnotationEvent) => void;
  stop: () => void;
};

/** The shell sends `viktor:annotation:configure` only where discussions are on. */
export function annotationRelay(
  load: () => Promise<AnnotationReceiver | null>,
): AnnotationReceiver {
  let layer: Promise<AnnotationReceiver | null> | null = null;
  return {
    receive: event => {
      if (layer === null) {
        if (event.type !== ANNOTATION_CONFIGURE) return;
        layer = load().catch(() => null);
      }
      void layer.then(running => running?.receive(event));
    },
    stop: () => {
      void layer?.then(running => running?.stop());
    },
  };
}

export function routeMessage(path: string, title: string): EmbedToShellMessage {
  const trimmed = title.trim();
  return {
    source: EMBED_MESSAGE_SOURCE,
    version: EMBED_BRIDGE_VERSION,
    type: "route",
    path,
    ...(trimmed ? { title: trimmed } : {}),
  };
}

export function postToShell(
  origin: string,
  message: EmbedToShellMessage,
): void {
  window.parent.postMessage(message, origin);
}
