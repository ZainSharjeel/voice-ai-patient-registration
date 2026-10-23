/**
 * The events are those of the dashboard's layer for Pages
 * (`components/annotations/page-bridge.ts` there), carried in the bridge's
 * `annotation` envelope; keep the two in step. This layer reads each item's
 * `target` where that one reads its location fields, and only this one
 * takes `configure`.
 *
 * Nothing stamps a Space's markup, so element ids are computed here: a
 * hash of the element's DOM id, or of its tag, its text and its occurrence
 * among elements with the same tag and text. An id finds its element
 * again while the content holds. When the content changes, a text target
 * is found by its quote and context, and an element target by its text.
 */

import {
  ANNOTATION_CONFIGURE,
  type AnnotationEvent,
  safeAppPath,
} from "./bridge";

/** The elements annotations point at; the dashboard's Pages use the same set. */
export const ELEMENT_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "dt",
  "dd",
  "pre",
  "td",
  "th",
  "caption",
  "figure",
  "figcaption",
  "img",
  "svg",
  "canvas",
  "blockquote",
  "summary",
  "div",
  "section",
] as const;
const SELECTOR = ELEMENT_TAGS.join(",");
const MAX_QUOTE = 20000;
const CONTEXT = 40;
export const FOCUS_WAIT_MS = 5000;
const FOCUS_RETRY_MS = 250;
const MISSING_RETRY_MS = 1000;
const HOLD_MS = 500;
const RING_DELAY_MS = 120;
const HOLD_SLOP_PX = 6;
const INTERACTIVE =
  'a[href],button,input,textarea,select,label,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link]';
const EDITABLE =
  'input,textarea,select,[contenteditable=""],[contenteditable=true]';

export type AnnotationTarget = {
  kind: "element" | "text";
  element_id: string;
  end_element_id?: string | null;
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  revision: string;
  path?: string | null;
};

export type AnnotationLayerOptions = {
  post: (event: AnnotationEvent) => void;
  navigate: (path: string) => void;
  /** The app-relative route the reader is on (`/orders?tab=open`). */
  route: () => string;
};

export type AnnotationLayer = {
  receive: (event: AnnotationEvent) => void;
  stop: () => void;
};

export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** cyrb53: a fast 53-bit string hash, spread well enough for element ids. */
export function hash53(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function elementKey(tag: string, domId: string, text: string): string {
  return domId ? `#${domId}` : `${tag}:${text.slice(0, 500)}:${text.length}`;
}

export function elementId(key: string, occurrence: number): string {
  return `s-${hash53(`${key}:${occurrence}`)}`;
}

const routeKey = (path: string) => safeAppPath(path) ?? path;

/** A target without a route is on every route. */
export function sameRoute(a: string | null | undefined, b: string): boolean {
  return !a || routeKey(a) === routeKey(b);
}

const squash = (value: string) => value.replace(/\s+/gu, "");

/**
 * The span (code points into the blocks' texts joined by one newline) the
 * quote occupies, taken at the stored offsets when they still hold the
 * quote, else wherever the quote occurs exactly once.
 */
export function quoteSpan(
  texts: readonly string[],
  exact: string,
  start: number,
  end: number,
): [number, number] | null {
  const joined = Array.from(texts.join("\n"));
  if (
    end > start &&
    normalizeText(joined.slice(start, end).join("")) === normalizeText(exact)
  ) {
    return [start, end];
  }
  const flat = joined.join("");
  const needle = exact.replace(/^\n+|\n+$/gu, "");
  const at = needle ? flat.indexOf(needle) : -1;
  if (at < 0 || flat.indexOf(needle, at + 1) >= 0) return null;
  const from = Array.from(flat.slice(0, at)).length;
  return [from, from + Array.from(needle).length];
}

/**
 * Where a quote sits among all the blocks' texts (joined by one newline),
 * in code points: the one occurrence, or the one its prefix and suffix
 * single out. Null when it is absent or stays ambiguous.
 */
export function findQuote(
  texts: readonly string[],
  exact: string,
  prefix: string,
  suffix: string,
): { start: number; end: number } | null {
  const needle = exact.replace(/^\n+|\n+$/gu, "");
  if (!needle.trim()) return null;
  const full = texts.join("\n");
  let best = -1;
  let bestScore = -1;
  let tied = false;
  for (
    let at = full.indexOf(needle);
    at >= 0;
    at = full.indexOf(needle, at + 1)
  ) {
    const score =
      (prefix && full.slice(Math.max(0, at - prefix.length), at) === prefix
        ? 1
        : 0) +
      (suffix &&
      full.slice(at + needle.length, at + needle.length + suffix.length) ===
        suffix
        ? 1
        : 0);
    if (score > bestScore) {
      best = at;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (best < 0 || tied) return null;
  const start = Array.from(full.slice(0, best)).length;
  return { start, end: start + Array.from(needle).length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const asCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
const asString = (value: unknown) => (typeof value === "string" ? value : "");

export function parseTarget(value: unknown): AnnotationTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "element" && value.kind !== "text") return null;
  if (typeof value.element_id !== "string") return null;
  return {
    kind: value.kind,
    element_id: value.element_id,
    end_element_id:
      typeof value.end_element_id === "string" ? value.end_element_id : null,
    exact: asString(value.exact),
    prefix: asString(value.prefix),
    suffix: asString(value.suffix),
    start: asCount(value.start),
    end: asCount(value.end),
    revision: asString(value.revision),
    path: typeof value.path === "string" ? value.path : null,
  };
}

const NAMES: Record<string, string> = {
  p: "Paragraph",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  li: "List item",
  dt: "Term",
  dd: "Description",
  td: "Cell",
  th: "Header cell",
  caption: "Caption",
  img: "Image",
  svg: "Graphic",
  canvas: "Chart",
  figure: "Figure",
  figcaption: "Caption",
  section: "Section",
  blockquote: "Quote",
  pre: "Code block",
  summary: "Summary",
  div: "Block",
};
const GENERIC = new Set(["div", "section", "li", "td", "th"]);

const STYLE =
  ":host{color-scheme:light}*{box-sizing:border-box}svg{width:14px;height:14px;flex:none}" +
  '.surface{position:fixed;display:none;pointer-events:auto;font:500 13px/18px system-ui,-apple-system,"Segoe UI",sans-serif;animation:pop .16s cubic-bezier(.2,.8,.2,1) both}' +
  ".surface.open{display:flex}" +
  "button{border:0;background:none;color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap}" +
  ".toolbar{align-items:center;gap:2px;padding:3px;border-radius:10px;background:#292330;color:#fff;box-shadow:0 6px 20px #1c1a1838}" +
  '.toolbar:after{content:"";position:absolute;left:50%;bottom:-5px;width:10px;height:10px;border-radius:2px;background:#292330;transform:translateX(-50%) rotate(45deg)}' +
  ".toolbar button{height:28px;padding:0 10px;border-radius:7px;font-size:12.5px;gap:6px}" +
  ".toolbar button:hover,.toolbar button:focus-visible{background:#ffffff1f;outline:none}" +
  ".toolbar .in{padding:0 8px 0 4px;color:#ffffff99;font-size:11.5px;font-weight:400;white-space:nowrap}" +
  ".menu{flex-direction:column;min-width:224px;max-width:300px;padding:6px;border-radius:12px;background:#fff;color:#292330;box-shadow:0 10px 30px #1c1a182e,0 0 0 1px #e8e3ec}" +
  ".menu .head{padding:4px 10px 6px;color:#8a8494;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".menu button{height:32px;padding:0 10px;border-radius:8px;font-size:13.5px;text-align:left}" +
  ".menu button:hover,.menu button:focus-visible{background:#f4f0ff;outline:none}" +
  ".menu button svg{color:#8a8494}" +
  ".menu .sep{height:1px;margin:4px 6px;background:#eee9f0}" +
  ".box{position:fixed;display:none;pointer-events:none;border-radius:8px;outline:1.5px solid #9b7cff;outline-offset:3px;background:#9b7cff0d;transition:left .14s,top .14s,width .14s,height .14s}" +
  ".box.open{display:block}.box.hover{outline-color:#9b7cff80;background:none}" +
  ".box .tag{position:absolute;left:-4px;top:-27px;padding:2px 7px;border-radius:6px;background:#7749ff;color:#fff;font:600 11px/16px system-ui,-apple-system,sans-serif;white-space:nowrap}" +
  ".ring{position:fixed;display:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;place-items:center;background:#9b7cff2e;box-shadow:0 0 0 1.5px #9b7cff73;pointer-events:none}" +
  ".ring.open{display:grid;animation:grow .38s cubic-bezier(.2,.7,.2,1) both}" +
  ".ring i{width:8px;height:8px;border-radius:50%;background:#7749ff;animation:fill .38s cubic-bezier(.2,.7,.2,1) both}" +
  "@keyframes pop{from{opacity:0;transform:scale(.985) translateY(6px)}to{opacity:1;transform:none}}" +
  "@keyframes grow{0%{opacity:0;transform:scale(.2)}25%{opacity:1}to{opacity:1;transform:scale(1)}}" +
  "@keyframes fill{from{transform:scale(.4)}to{transform:scale(2.6)}}" +
  "@media (prefers-reduced-motion:reduce){*{animation-duration:1ms!important;transition-duration:1ms!important}}";
const DOCUMENT_STYLE =
  "::highlight(annotation){background:#e3d7ff;color:inherit}::highlight(annotation-pending){background:#e3d7ff;color:inherit}[data-annotation-active]{outline:2px solid #9569ec;outline-offset:4px;background-color:#9569ec12;scroll-margin:40px}[data-viktor-holding],[data-viktor-holding] *{user-select:none!important;-webkit-user-select:none!important}";
const ICON_DISCUSS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

type Index = {
  elements: Element[];
  ids: Map<Element, string>;
  byId: Map<string, Element>;
  quotable: Set<Element>;
};
type Spot = { block: Element; range: Range | null };
type Pending = {
  element: Element;
  range: Range | null;
  dx: number;
  dy: number;
};
type Selected = { range: Range; block: Element; target: AnnotationTarget };
type Hold = {
  x: number;
  y: number;
  armed: boolean;
  pointerId: number;
  source: Element;
  ringTimer: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
};
type Tracked = {
  id: string;
  target: AnnotationTarget;
  quote: string;
  route: string | null;
};

export function startAnnotationLayer(
  options: AnnotationLayerOptions,
): AnnotationLayer {
  let revision = "";
  let canEdit = false;
  const removers: (() => void)[] = [];
  const listen = (
    target: EventTarget,
    type: string,
    handler: (event: any) => void,
    capture = false,
  ) => {
    target.addEventListener(type, handler, capture);
    removers.push(() => target.removeEventListener(type, handler, capture));
  };
  const { route } = options;
  const post = (type: string, data: Record<string, unknown> = {}) =>
    options.post({ ...data, type });
  const reducedMotion = () =>
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const box = (rect: DOMRect) => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });

  const host = document.createElement("div");
  host.dataset.viktorAnnotationUi = "";
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const ui = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  ui.append(style);

  const text = (element: Element): string => {
    if (element.localName === "img") {
      return element.getAttribute("alt") || "Image";
    }
    const own = normalizeText(element.textContent || "");
    return own || normalizeText(element.getAttribute("aria-label") || "");
  };
  const isCandidate = (element: Element) =>
    element !== host &&
    !(
      element.localName === "svg" &&
      (element.parentElement?.closest("svg") ||
        element.parentElement?.closest(INTERACTIVE))
    );
  const candidateOf = (node: Node | null): Element | null => {
    let element =
      node === null
        ? null
        : node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement;
    element = element?.closest(SELECTOR) ?? null;
    while (element && !isCandidate(element)) {
      element = element.parentElement?.closest(SELECTOR) ?? null;
    }
    return element;
  };

  let index: Index | null = null;
  const getIndex = (): Index => {
    if (index) return index;
    const elements = [...document.body.querySelectorAll(SELECTOR)].filter(
      isCandidate,
    );
    const ids = new Map<Element, string>();
    const byId = new Map<string, Element>();
    const quotable = new Set(elements);
    const seen = new Map<string, number>();
    for (const element of elements) {
      const parent = candidateOf(element.parentElement);
      if (parent) quotable.delete(parent);
      const key = elementKey(element.localName, element.id, text(element));
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const id = elementId(key, occurrence);
      ids.set(element, id);
      if (!byId.has(id)) byId.set(id, element);
    }
    index = { elements, ids, byId, quotable };
    return index;
  };
  const idOf = (element: Element) => getIndex().ids.get(element) ?? "";
  const isQuotable = (element: Element) => getIndex().quotable.has(element);
  const quotables = () => {
    const current = getIndex();
    return current.elements.filter(element => current.quotable.has(element));
  };
  const blockOf = (node: Node | null) => {
    let element = candidateOf(node);
    while (element && !isQuotable(element)) {
      element = candidateOf(element.parentElement);
    }
    return element;
  };
  const nameOf = (element: Element) =>
    NAMES[element.localName] ?? element.localName;
  const snippet = (element: Element) => {
    const value =
      normalizeText((element as HTMLElement).innerText || "") || text(element);
    return value.length > 26 ? `${value.slice(0, 25).trimEnd()}…` : value;
  };
  const genericSnippet = (element: Element) =>
    GENERIC.has(element.localName) ? snippet(element) : "";
  const labelOf = (element: Element) => {
    const words = genericSnippet(element);
    return words ? `“${words}”` : nameOf(element);
  };
  const headOf = (element: Element) => {
    const words = genericSnippet(element);
    return words ? `${nameOf(element)} · ${words}` : nameOf(element);
  };
  const elementTarget = (element: Element): AnnotationTarget => ({
    kind: "element",
    element_id: idOf(element),
    exact: text(element).slice(0, MAX_QUOTE),
    prefix: "",
    suffix: "",
    start: 0,
    end: 0,
    revision,
    path: route(),
  });

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    parent: ParentNode = ui,
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    parent.append(element);
    return element;
  };
  const button = (
    parent: ParentNode,
    icon: string,
    label: string,
    onActivate: () => void,
  ) => {
    const element = make("button", "", parent);
    element.type = "button";
    element.innerHTML = icon;
    element.append(document.createTextNode(label));
    element.addEventListener("click", event => {
      event.stopPropagation();
      onActivate();
    });
    return element;
  };
  const pendingBox = make("div", "box");
  const pendingTag = make("span", "tag", pendingBox);
  const hoverBox = make("div", "box hover");
  const ring = make("div", "ring");
  make("i", "", ring);
  const menu = make("div", "surface menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Element actions");
  const toolbar = make("div", "surface toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Text selection actions");
  document.body.append(host);
  const documentStyle = document.createElement("style");
  documentStyle.textContent = DOCUMENT_STYLE;
  document.head.append(documentStyle);

  const place = (
    element: HTMLElement,
    x: number,
    y: number,
    above: boolean,
  ) => {
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(innerWidth - bounds.width - 8, x))}px`;
    const top =
      above && y - bounds.height - 10 >= 8 ? y - bounds.height - 10 : y + 8;
    element.style.top = `${Math.max(8, Math.min(innerHeight - bounds.height - 8, top))}px`;
  };
  const outline = (
    target: HTMLElement,
    element: Element | null,
    tag?: string,
  ) => {
    if (!element) {
      target.classList.remove("open");
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(target.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    if (tag !== undefined) pendingTag.textContent = tag;
    target.classList.add("open");
  };

  let menuOpen = false;
  let hovered: Element | null = null;
  let pending: Pending | null = null;
  let anchored = "";
  const closeSurfaces = () => {
    menu.classList.remove("open");
    toolbar.classList.remove("open");
    if (menuOpen && !pending) outline(pendingBox, null);
    menuOpen = false;
  };
  const clearPending = () => {
    pending = null;
    CSS.highlights?.delete("annotation-pending");
    outline(pendingBox, null);
  };
  const geometry = () => {
    if (!pending || !pending.element.isConnected) return null;
    const rect = (pending.range ?? pending.element).getBoundingClientRect();
    return {
      rect: box(rect),
      point: { x: rect.left + pending.dx, y: rect.top + pending.dy },
    };
  };
  const offer = (
    target: AnnotationTarget,
    element: Element,
    label: string,
    x: number,
    y: number,
    range: Range | null = null,
  ) => {
    const rect = (range ?? element).getBoundingClientRect();
    pending = { element, range, dx: x - rect.left, dy: y - rect.top };
    CSS.highlights?.delete("annotation-pending");
    if (range && CSS.highlights) {
      CSS.highlights.set("annotation-pending", new Highlight(range));
    }
    outline(pendingBox, element, label);
    const where = geometry();
    anchored = JSON.stringify(where);
    return { target, label, ...where };
  };
  const pick = (
    target: AnnotationTarget,
    element: Element,
    label: string,
    x: number,
    y: number,
    range: Range | null = null,
  ) => {
    closeSurfaces();
    post(
      "viktor:annotation:selection",
      offer(target, element, label, x, y, range),
    );
    getSelection()?.removeAllRanges();
  };

  const selectedText = (): Selected | undefined => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const first = blockOf(range.startContainer);
    const last = blockOf(range.endContainer);
    if (!first || !last) return;
    const blocks = quotables();
    const from = blocks.indexOf(first);
    const to = blocks.indexOf(last);
    if (from < 0 || to < from) return;
    const before = range.cloneRange();
    before.selectNodeContents(first);
    before.setEnd(range.startContainer, range.startOffset);
    const through = range.cloneRange();
    through.selectNodeContents(last);
    through.setEnd(range.endContainer, range.endOffset);
    const offset = (value: string) =>
      value.replace(/\s+/gu, " ").trimStart().length;
    const start = offset(before.toString());
    const end =
      blocks.slice(from, to).reduce((sum, b) => sum + text(b).length + 1, 0) +
      offset(through.toString());
    const full = blocks
      .slice(from, to + 1)
      .map(text)
      .join("\n");
    const exact = full.slice(start, end);
    if (!exact.trim() || exact.length > MAX_QUOTE) return;
    const startCodePoints = Array.from(full.slice(0, start)).length;
    return {
      range: range.cloneRange(),
      block: first,
      target: {
        kind: "text",
        element_id: idOf(first),
        end_element_id: idOf(last),
        exact,
        start: startCodePoints,
        end: startCodePoints + Array.from(exact).length,
        prefix: full.slice(Math.max(0, start - CONTEXT), start),
        suffix: full.slice(end, end + CONTEXT),
        revision,
        path: route(),
      },
    };
  };
  const pickText = (selected: Selected) => {
    const rect = selected.range.getBoundingClientRect();
    pick(
      selected.target,
      selected.block,
      nameOf(selected.block),
      rect.left + rect.width / 2,
      rect.bottom,
      selected.range,
    );
  };
  const showSelection = () => {
    if (!canEdit) return;
    const selected = selectedText();
    if (!selected) {
      if (!menuOpen) closeSurfaces();
      return;
    }
    closeSurfaces();
    toolbar.replaceChildren();
    button(toolbar, ICON_DISCUSS, "Discuss", () => pickText(selected));
    make("span", "in", toolbar).textContent = `in ${nameOf(selected.block)}`;
    toolbar.classList.add("open");
    const bounds = selected.range.getBoundingClientRect();
    const width = toolbar.getBoundingClientRect().width;
    place(
      toolbar,
      bounds.left + bounds.width / 2 - width / 2,
      bounds.top,
      true,
    );
  };

  const openMenu = (
    element: Element,
    x: number,
    y: number,
    selected: Selected | null,
  ) => {
    toolbar.classList.remove("open");
    menuOpen = true;
    menu.replaceChildren();
    make("div", "head", menu).textContent = headOf(element);
    const discuss = button(menu, ICON_DISCUSS, "Discuss with Viktor", () =>
      selected
        ? pickText(selected)
        : pick(elementTarget(element), element, labelOf(element), x, y),
    );
    if (selected) {
      make("div", "sep", menu);
      button(menu, ICON_COPY, "Copy", () => {
        navigator.clipboard
          ?.writeText(selected.range.toString())
          .catch(() => {});
        closeSurfaces();
      });
    }
    for (const item of menu.querySelectorAll("button")) {
      item.setAttribute("role", "menuitem");
    }
    menu.classList.add("open");
    place(menu, x, y, false);
    outline(pendingBox, element, labelOf(element));
    discuss.focus({ preventScroll: true });
  };

  let hold: Hold | null = null;
  const swallowClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const endHold = (phase: "end" | "cancel" | "blur") => {
    if (!hold) return;
    clearTimeout(hold.ringTimer);
    clearTimeout(hold.timer);
    ring.classList.remove("open");
    document.documentElement.removeAttribute("data-viktor-holding");
    if (hold.armed) {
      post("viktor:annotation:hold", { phase });
      if (phase === "cancel") clearPending();
      addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallowClick, true), 0);
    }
    hold = null;
  };
  listen(
    window,
    "pointerdown",
    (event: PointerEvent) => {
      if (event.composedPath().includes(host)) {
        event.preventDefault();
        return;
      }
      closeSurfaces();
      const source = event.target instanceof Element ? event.target : null;
      if (
        !canEdit ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        !source ||
        source.closest(INTERACTIVE)
      ) {
        return;
      }
      const element = candidateOf(source);
      if (!element) return;
      const x = event.clientX;
      const y = event.clientY;
      const ringTimer = setTimeout(() => {
        Object.assign(ring.style, { left: `${x}px`, top: `${y}px` });
        ring.classList.add("open");
      }, RING_DELAY_MS);
      const timer = setTimeout(() => {
        if (!hold) return;
        hold.armed = true;
        ring.classList.remove("open");
        getSelection()?.removeAllRanges();
        document.documentElement.setAttribute("data-viktor-holding", "");
        try {
          hold.source.setPointerCapture(hold.pointerId);
        } catch {
          // The pointer may already be gone; the hold still ends on release.
        }
        post("viktor:annotation:hold", {
          phase: "start",
          ...offer(elementTarget(element), element, labelOf(element), x, y),
        });
      }, HOLD_MS);
      hold = {
        x,
        y,
        armed: false,
        pointerId: event.pointerId,
        source,
        ringTimer,
        timer,
      };
    },
    true,
  );
  listen(
    window,
    "pointermove",
    (event: PointerEvent) => {
      if (!hold) return;
      if (hold.armed && event.buttons === 0) endHold("end");
      else if (
        !hold.armed &&
        Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >
          HOLD_SLOP_PX
      ) {
        endHold("cancel");
      }
    },
    true,
  );
  listen(
    window,
    "pointerup",
    (event: PointerEvent) => {
      const wasArmed = hold?.armed;
      endHold("end");
      if (
        !wasArmed &&
        event.button === 0 &&
        !event.composedPath().includes(host)
      ) {
        showSelection();
      }
    },
    true,
  );
  listen(window, "pointercancel", () => endHold("cancel"), true);
  // A microphone permission prompt takes focus mid-hold: keep the draft and its recording.
  listen(window, "blur", () => endHold(hold?.armed ? "blur" : "cancel"));
  listen(document, "keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (hold) endHold("cancel");
      else if (menuOpen || toolbar.classList.contains("open")) closeSurfaces();
      else if (pending) {
        clearPending();
        post("viktor:annotation:dismiss");
      }
      return;
    }
    if (event.key === "Tab") {
      closeSurfaces();
      return;
    }
    if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button")];
      const at = items.indexOf(ui.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  });
  listen(document, "keyup", (event: KeyboardEvent) => {
    if (
      event.shiftKey &&
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      showSelection();
    }
  });
  listen(document, "selectionchange", () => {
    if (toolbar.classList.contains("open") && getSelection()?.isCollapsed) {
      closeSurfaces();
    }
  });
  listen(document, "contextmenu", (event: MouseEvent) => {
    const source = event.target instanceof Element ? event.target : null;
    if (
      !canEdit ||
      !source ||
      event.composedPath().includes(host) ||
      source.closest(EDITABLE)
    ) {
      return;
    }
    const element = candidateOf(source);
    if (!element) return;
    event.preventDefault();
    endHold("cancel");
    const selected = selectedText();
    const onSelection = selected?.range.intersectsNode(source)
      ? selected
      : null;
    const bounds = element.getBoundingClientRect();
    openMenu(
      element,
      event.clientX || bounds.left,
      event.clientY || bounds.top,
      onSelection,
    );
  });

  const positions = (element: Element) => {
    const result: {
      node: Node;
      offset: number;
      end: number;
      space: boolean;
    }[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let whitespace = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let offset = 0;
      for (const character of node.textContent ?? "") {
        if (/\s/u.test(character)) {
          if (result.length && !whitespace) {
            result.push({
              node,
              offset,
              end: offset + character.length,
              space: true,
            });
          }
          whitespace = true;
        } else {
          result.push({
            node,
            offset,
            end: offset + character.length,
            space: false,
          });
          whitespace = false;
        }
        offset += character.length;
      }
    }
    if (result.at(-1)?.space) result.pop();
    return result;
  };
  const locate = (elements: readonly Element[], at: number) => {
    let base = 0;
    for (const element of elements) {
      const length = Array.from(text(element)).length;
      if (at < base + length) return { element, local: at - base };
      base += length + 1;
    }
    return null;
  };
  const rangeFor = (
    elements: readonly Element[],
    start: number,
    end: number,
  ) => {
    const first = locate(elements, start);
    const last = locate(elements, end - 1);
    if (!first || !last) return null;
    const from = positions(first.element)[first.local];
    const to = positions(last.element)[last.local];
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.end);
    return range;
  };
  const locateTarget = (target: AnnotationTarget): Spot | null => {
    const current = getIndex();
    const first = current.byId.get(target.element_id) ?? null;
    if (target.kind === "element") {
      if (first) return { block: first, range: null };
      if (!normalizeText(target.exact)) return null;
      const matches = current.elements.filter(
        element => text(element).slice(0, MAX_QUOTE) === target.exact,
      );
      return matches.length === 1 ? { block: matches[0], range: null } : null;
    }
    const blocks = quotables();
    const last = target.end_element_id
      ? (current.byId.get(target.end_element_id) ?? null)
      : first;
    if (first && last) {
      const from = blocks.indexOf(first);
      const to = blocks.indexOf(last);
      if (from >= 0 && to >= from) {
        const slice = blocks.slice(from, to + 1);
        const span = quoteSpan(
          slice.map(text),
          target.exact,
          target.start,
          target.end,
        );
        const range = span && rangeFor(slice, span[0], span[1]);
        if (range) return { block: first, range };
      }
    }
    const found = findQuote(
      blocks.map(text),
      target.exact,
      target.prefix,
      target.suffix,
    );
    const range = found && rangeFor(blocks, found.start, found.end);
    const block = found && locate(blocks, found.start)?.element;
    return range && block ? { block, range } : null;
  };
  const holds = (spot: Spot, item: Tracked) =>
    spot.block.isConnected &&
    (spot.range === null || squash(spot.range.toString()) === item.quote);

  let tracked: Tracked[] = [];
  const spots = new Map<string, Spot>();
  const missedAt = new Map<string, number>();
  let spotsStale = true;
  const spotOf = (item: Tracked): Spot | null => {
    const known = spots.get(item.id);
    if (known && (!spotsStale || holds(known, item))) return known;
    spots.delete(item.id);
    const now = Date.now();
    if (now - (missedAt.get(item.id) ?? 0) < MISSING_RETRY_MS) return null;
    const spot = locateTarget(item.target);
    if (spot) {
      spots.set(item.id, spot);
      missedAt.delete(item.id);
    } else {
      missedAt.set(item.id, now);
    }
    return spot;
  };
  const onRoute = () => {
    const here = routeKey(route());
    return tracked.filter(item => item.route === null || item.route === here);
  };

  const clearFocus = () => {
    for (const element of document.querySelectorAll(
      "[data-annotation-active]",
    )) {
      element.removeAttribute("data-annotation-active");
    }
    CSS.highlights?.delete("annotation");
  };
  let focusing: {
    target: AnnotationTarget;
    scroll: boolean;
    until: number;
  } | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const tryFocus = () => {
    clearTimeout(focusTimer);
    if (!focusing) return;
    const { target, scroll, until } = focusing;
    const spot = sameRoute(target.path, route()) ? locateTarget(target) : null;
    if (!spot) {
      if (Date.now() < until) focusTimer = setTimeout(tryFocus, FOCUS_RETRY_MS);
      else focusing = null;
      return;
    }
    focusing = null;
    if (spot.range && CSS.highlights) {
      CSS.highlights.set("annotation", new Highlight(spot.range));
    }
    spot.block.setAttribute("data-annotation-active", "");
    const rect = (spot.range ?? spot.block).getBoundingClientRect();
    if (scroll && (rect.top < 24 || rect.bottom > innerHeight - 24)) {
      spot.block.scrollIntoView({
        block: "center",
        behavior: reducedMotion() ? "instant" : "smooth",
      });
    }
  };
  const focus = (event: AnnotationEvent) => {
    closeSurfaces();
    clearFocus();
    const target = parseTarget(event.target);
    focusing = null;
    if (!target) return;
    if (!sameRoute(target.path, route())) {
      const path = safeAppPath(target.path);
      if (path !== null) options.navigate(path);
    }
    focusing = {
      target,
      scroll: event.scroll !== false,
      until: Date.now() + FOCUS_WAIT_MS,
    };
    tryFocus();
  };

  let frame = 0;
  let reported = "";
  let reportedRoute = route();
  const report = () => {
    frame = 0;
    const here = route();
    if (here !== reportedRoute) {
      reportedRoute = here;
      if (!focusing) clearFocus();
      if (hovered && !hovered.isConnected) hovered = null;
    }
    if (pending) {
      const where = geometry();
      if (where) {
        const serialized = JSON.stringify(where);
        if (serialized !== anchored) {
          anchored = serialized;
          post("viktor:annotation:anchor", where);
        }
        outline(pendingBox, pending.element);
      }
    }
    outline(hoverBox, hovered);
    const placed: Record<string, number> = {};
    for (const item of onRoute()) {
      const spot = spotOf(item);
      const rect = spot && (spot.range ?? spot.block).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        placed[item.id] = Math.round(rect.top);
      }
    }
    spotsStale = false;
    const serialized = JSON.stringify(placed);
    if (serialized !== reported) {
      reported = serialized;
      post("viktor:annotation:positions", { positions: placed });
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(report);
  };
  const changes = new MutationObserver(() => {
    index = null;
    spotsStale = true;
    schedule();
  });
  changes.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  listen(
    document,
    "scroll",
    () => {
      closeSurfaces();
      schedule();
    },
    true,
  );
  listen(window, "resize", () => {
    closeSurfaces();
    schedule();
  });
  listen(window, "popstate", schedule);
  const resizes =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  resizes?.observe(document.documentElement);

  const receive = (event: AnnotationEvent) => {
    switch (event.type) {
      case ANNOTATION_CONFIGURE:
        revision = asString(event.revision);
        canEdit = event.canEdit === true && revision !== "";
        if (!canEdit) {
          closeSurfaces();
          clearPending();
        }
        return;
      case "viktor:annotation:focus":
        focus(event);
        return;
      case "viktor:annotation:hover": {
        const id = asString(event.elementId);
        const item = onRoute().find(entry => entry.target.element_id === id);
        hovered = id ? ((item && spotOf(item)?.block) ?? null) : null;
        outline(hoverBox, hovered);
        return;
      }
      case "viktor:annotation:pending":
        if (event.active !== true) clearPending();
        return;
      case "viktor:annotation:track": {
        const items = Array.isArray(event.items) ? event.items : [];
        tracked = items.flatMap(item => {
          const target = isRecord(item) ? parseTarget(item.target) : null;
          return target && typeof item.id === "string"
            ? [
                {
                  id: item.id,
                  target,
                  quote: squash(target.exact),
                  route: target.path ? routeKey(target.path) : null,
                },
              ]
            : [];
        });
        const ids = new Set(tracked.map(item => item.id));
        for (const id of [...spots.keys()]) if (!ids.has(id)) spots.delete(id);
        missedAt.clear();
        spotsStale = true;
        reported = "";
        schedule();
        return;
      }
      case "viktor:annotation:scroll":
        scrollBy({ top: Number(event.dy) || 0, behavior: "instant" });
        return;
      case "viktor:annotation:release":
        if (hold?.armed) endHold("end");
        return;
    }
  };

  const stop = () => {
    for (const remove of removers) remove();
    changes.disconnect();
    resizes?.disconnect();
    clearTimeout(focusTimer);
    if (frame) cancelAnimationFrame(frame);
    endHold("cancel");
    clearPending();
    clearFocus();
    host.remove();
    documentStyle.remove();
  };

  return { receive, stop };
}
