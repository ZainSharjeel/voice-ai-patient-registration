import { describe, expect, test } from "bun:test";
import {
  elementId,
  elementKey,
  findQuote,
  hash53,
  parseTarget,
  quoteSpan,
  sameRoute,
} from "../src/lib/viktor-embed/annotations";
import {
  ANNOTATION_CONFIGURE,
  type AnnotationReceiver,
  annotationMessage,
  annotationRelay,
  type EmbedEnvironment,
  isShellMessage,
  readyMessage,
  resolveShellOrigin,
  routeMessage,
  SHELL_ORIGIN_STORAGE_KEY,
  safeAppPath,
  shellOriginFromHash,
} from "../src/lib/viktor-embed/bridge";

const SHELL = "https://app.viktor.com";
const OWN = "https://acme.viktor.space";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function env(overrides: Partial<EmbedEnvironment> = {}): EmbedEnvironment {
  return {
    framed: true,
    ownOrigin: OWN,
    hash: "",
    referrer: "",
    storage: new MemoryStorage(),
    ...overrides,
  };
}

describe("resolveShellOrigin", () => {
  test("first entry: framed, referrer is the shell (strip redirect keeps its origin)", () => {
    const storage = new MemoryStorage();
    expect(
      resolveShellOrigin(env({ referrer: `${SHELL}/knowledge`, storage })),
    ).toBe(SHELL);
    // Remembered for the next document in this tab.
    expect(storage.getItem(SHELL_ORIGIN_STORAGE_KEY)).toBe(SHELL);
  });

  test("post-navigation document: no referrer, the remembered origin still talks to the shell", () => {
    // A full-page navigation or reload inside the frame arrives with an empty
    // referrer (pages send `referrer-policy: no-referrer`); the frame must not
    // fall silent, or breadcrumb navigation looks like a stalled embed.
    const storage = new MemoryStorage();
    storage.setItem(SHELL_ORIGIN_STORAGE_KEY, SHELL);
    expect(resolveShellOrigin(env({ referrer: "", storage }))).toBe(SHELL);
  });

  test("post-navigation document: the fragment carries the origin even without storage", () => {
    expect(
      resolveShellOrigin(
        env({
          referrer: "",
          storage: null,
          hash: `#viktor-shell=${encodeURIComponent(SHELL)}`,
        }),
      ),
    ).toBe(SHELL);
    expect(
      resolveShellOrigin(
        env({
          referrer: "",
          storage: null,
          hash: `#section&viktor-shell=${encodeURIComponent(SHELL)}`,
        }),
      ),
    ).toBe(SHELL);
  });

  test("framed-ness comes from the window tree, not the referrer", () => {
    // Not framed: silent even with a cross-origin referrer.
    expect(
      resolveShellOrigin(env({ framed: false, referrer: `${SHELL}/` })),
    ).toBeNull();
    // Framed by a page on our own origin: not the dashboard shell.
    expect(resolveShellOrigin(env({ referrer: `${OWN}/other` }))).toBeNull();
    // Framed, nothing to learn the origin from: silent, never a wildcard.
    expect(resolveShellOrigin(env({ referrer: "", storage: null }))).toBeNull();
  });

  test("a fresh referrer wins over a stale remembered origin", () => {
    const storage = new MemoryStorage();
    storage.setItem(SHELL_ORIGIN_STORAGE_KEY, "https://old.example");
    expect(resolveShellOrigin(env({ referrer: `${SHELL}/`, storage }))).toBe(
      SHELL,
    );
    expect(storage.getItem(SHELL_ORIGIN_STORAGE_KEY)).toBe(SHELL);
  });

  test("storage that throws is tolerated", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(
      resolveShellOrigin(env({ referrer: `${SHELL}/`, storage: broken })),
    ).toBe(SHELL);
    expect(
      resolveShellOrigin(env({ referrer: "", storage: broken })),
    ).toBeNull();
  });
});

describe("shellOriginFromHash", () => {
  test("reads only a well-formed origin", () => {
    expect(
      shellOriginFromHash(
        `#viktor-shell=${encodeURIComponent("https://app.viktor.com/x")}`,
      ),
    ).toBe(SHELL);
    expect(shellOriginFromHash("#viktor-shell=not-a-url")).toBeNull();
    expect(shellOriginFromHash("#viktor-shell=%E0%A4%A")).toBeNull();
    expect(shellOriginFromHash("#other=1")).toBeNull();
    expect(shellOriginFromHash("")).toBeNull();
  });
});

describe("envelopes", () => {
  test("safeAppPath keeps app-relative paths only", () => {
    expect(safeAppPath("/orders?tab=open")).toBe("/orders?tab=open");
    expect(safeAppPath("//evil.example/x")).toBeNull();
    expect(safeAppPath("https://evil.example/x")).toBeNull();
    expect(safeAppPath("/a\\b")).toBeNull();
    expect(safeAppPath(42)).toBeNull();
  });

  test("isShellMessage accepts only the pinned shell envelopes", () => {
    expect(
      isShellMessage({
        source: "viktor-shell",
        version: 1,
        type: "theme",
        theme: "dark",
      }),
    ).toBe(true);
    expect(
      isShellMessage({
        source: "viktor-shell",
        version: 1,
        type: "navigate",
        path: "/x",
      }),
    ).toBe(true);
    expect(
      isShellMessage({
        source: "viktor-shell",
        version: 2,
        type: "theme",
        theme: "dark",
      }),
    ).toBe(false);
    expect(
      isShellMessage({ source: "viktor-embed", version: 1, type: "ready" }),
    ).toBe(false);
    expect(isShellMessage(null)).toBe(false);
  });

  test("routeMessage drops an empty title", () => {
    expect(routeMessage("/x", "  ")).toEqual({
      source: "viktor-embed",
      version: 1,
      type: "route",
      path: "/x",
    });
    expect(routeMessage("/x", " Orders ").title).toBe("Orders");
  });

  test("ready says the frame speaks annotations", () => {
    expect(readyMessage()).toEqual({
      source: "viktor-embed",
      version: 1,
      type: "ready",
      features: ["annotations"],
    });
  });

  test("annotation envelopes carry only annotation events", () => {
    const focus = { type: "viktor:annotation:focus", scroll: true };
    expect(
      isShellMessage({
        source: "viktor-shell",
        version: 1,
        type: "annotation",
        event: focus,
      }),
    ).toBe(true);
    for (const event of [null, "focus", { type: "focus" }, { type: 1 }]) {
      expect(
        isShellMessage({
          source: "viktor-shell",
          version: 1,
          type: "annotation",
          event,
        }),
      ).toBe(false);
    }
    expect(annotationMessage({ type: "viktor:annotation:dismiss" })).toEqual({
      source: "viktor-embed",
      version: 1,
      type: "annotation",
      event: { type: "viktor:annotation:dismiss" },
    });
  });
});

describe("annotation relay", () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  function recorder() {
    const received: string[] = [];
    let loads = 0;
    const layer: AnnotationReceiver = {
      receive: event => received.push(event.type),
      stop: () => received.push("stopped"),
    };
    const load = async () => {
      loads += 1;
      return layer;
    };
    return { received, load, loads: () => loads };
  }

  test("a frame the shell never configures loads no layer and runs none of it", async () => {
    const { received, load, loads } = recorder();
    const relay = annotationRelay(load);
    relay.receive({ type: "viktor:annotation:focus", annotation_id: "a1" });
    relay.receive({ type: "viktor:annotation:items", items: [] });
    relay.stop();
    await settle();
    expect(loads()).toBe(0);
    expect(received).toEqual([]);
  });

  test("configure loads the layer once and hands it every event from there on, in order", async () => {
    const { received, load, loads } = recorder();
    const relay = annotationRelay(load);
    relay.receive({ type: "viktor:annotation:focus" });
    relay.receive({ type: ANNOTATION_CONFIGURE, revision: "r1" });
    relay.receive({ type: "viktor:annotation:items", items: [] });
    relay.receive({ type: ANNOTATION_CONFIGURE, revision: "r2" });
    await settle();
    relay.stop();
    await settle();
    expect(loads()).toBe(1);
    expect(received).toEqual([
      ANNOTATION_CONFIGURE,
      "viktor:annotation:items",
      ANNOTATION_CONFIGURE,
      "stopped",
    ]);
  });

  test("a layer that fails to load drops its events and is not loaded again", async () => {
    let loads = 0;
    const relay = annotationRelay(() => {
      loads += 1;
      return Promise.reject(new Error("chunk failed"));
    });
    relay.receive({ type: ANNOTATION_CONFIGURE, revision: "r1" });
    relay.receive({ type: ANNOTATION_CONFIGURE, revision: "r2" });
    relay.stop();
    await settle();
    expect(loads).toBe(1);
  });
});

describe("annotation layer", () => {
  test("element ids are stable, short, and tell equal elements apart by occurrence", () => {
    const key = elementKey("p", "", "Revenue grew 12%");
    expect(elementId(key, 0)).toBe(
      elementId(elementKey("p", "", "Revenue grew 12%"), 0),
    );
    expect(elementId(key, 0)).not.toBe(elementId(key, 1));
    expect(elementId(key, 0)).not.toBe(
      elementId(elementKey("li", "", "Revenue grew 12%"), 0),
    );
    expect(elementId(key, 0)).toMatch(/^s-[0-9a-z]{1,12}$/);
    expect(elementKey("div", "kpi", "1,204")).toBe(
      elementKey("div", "kpi", "1,388"),
    );
    expect(hash53("")).toBe(hash53(""));
  });

  test("findQuote picks the occurrence its context singles out", () => {
    const texts = ["Orders by stage", "Open: 12", "Closed: 30", "Open: 12"];
    expect(findQuote(texts, "Closed", "", "")).toEqual({ start: 25, end: 31 });
    expect(findQuote(texts, "Open: 12", "", "")).toBeNull();
    expect(findQuote(texts, "12", "Open: ", "\nClosed")).toEqual({
      start: 22,
      end: 24,
    });
    expect(findQuote(["📦 Orders", "Open"], "Orders\nOpen", "📦 ", "")).toEqual(
      { start: 2, end: 13 },
    );
    expect(findQuote(texts, "Missing", "", "")).toBeNull();
    expect(findQuote(texts, "  ", "", "")).toBeNull();
  });

  test("quoteSpan keeps stored offsets that still hold the quote, else finds it once", () => {
    expect(quoteSpan(["We launch on Friday."], "on Friday", 10, 19)).toEqual([
      10, 19,
    ]);
    expect(
      quoteSpan(["Now we launch on Friday."], "on Friday", 10, 19),
    ).toEqual([14, 23]);
    expect(quoteSpan(["on Friday, on Friday"], "on Friday", 3, 12)).toBeNull();
  });

  test("routes compare as app paths, and a target without one is on every route", () => {
    expect(sameRoute("/orders?tab=open", "/orders?tab=open")).toBe(true);
    expect(sameRoute("/orders?tab=open", "/orders")).toBe(false);
    expect(sameRoute(null, "/orders")).toBe(true);
  });

  test("parseTarget accepts the dashboard's targets only", () => {
    expect(
      parseTarget({
        kind: "text",
        element_id: "s-1",
        exact: "on Friday",
        start: 10,
        end: 19,
        revision: "r1",
        path: "/plan",
      }),
    ).toEqual({
      kind: "text",
      element_id: "s-1",
      end_element_id: null,
      exact: "on Friday",
      prefix: "",
      suffix: "",
      start: 10,
      end: 19,
      revision: "r1",
      path: "/plan",
    });
    expect(parseTarget({ kind: "box", element_id: "s-1" })).toBeNull();
    expect(parseTarget({ kind: "text" })).toBeNull();
    expect(parseTarget(null)).toBeNull();
  });
});
