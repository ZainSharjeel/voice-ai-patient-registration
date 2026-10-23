/**
 * Design review artifact generator.
 *
 * Renders every key route at mobile / tablet / desktop viewports and produces
 * reviewable artifacts in tmp/design-review/latest/ (signed-out/ with
 * --signed-out):
 *
 * - <route>--<viewport>.png            full-page screenshots
 * - specimen--<route>.png              the largest display-type block on the
 *                                      desktop render, cropped at natural size —
 *                                      review leading/tracking optically here
 * - contact-sheet.png                  all screenshots stitched into one image
 * - contact-sheet-gray.png             the same sheet desaturated — hierarchy,
 *                                      primary actions, and section boundaries
 *                                      must survive with chroma removed
 * - report.md / report.json           deterministic checks per page
 *
 * Checks (deterministic floor — taste is judged from the contact sheet):
 * - horizontal overflow at every viewport
 * - axe-core WCAG 2.0/2.1 A+AA violations (serious/critical fail)
 * - console errors while rendering
 * - hardcoded hex colors in src/ outside index.css and platform-managed files
 *   (token discipline)
 * - computed fonts, flagged while typography is still the neutral baseline
 *
 * Usage:
 *   bun run design:review              # default: / and, with accounts, /dashboard /settings
 *   bun run design:review / /pricing   # explicit routes
 *   bun run design:review --signed-out # as a visitor: / /login /signup by default
 *
 * Exits non-zero when a blocking check fails. Review the contact sheet against
 * DESIGN.md, fix, and rerun until clean.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { createPageHelper, launchChromium, PageHelper } from "./auth";
import {
  exemptSourceFiles,
  type HexFinding,
  hexColorFindings,
} from "./design-review-hex";
import { specimenClip } from "./design-review-specimen";
import { noteIgnoredAppUrl, startPreviewServer } from "./preview-server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const signedOut = process.argv.includes("--signed-out");
const outDir = join(
  projectRoot,
  "tmp",
  "design-review",
  signedOut ? "signed-out" : "latest",
);

// The review browser is signed in as the test user, so auth-only pages render
// and public-only pages (/login, /signup) redirect; --signed-out flips both.
async function defaultRoutes(): Promise<string[]> {
  try {
    const descriptor = JSON.parse(
      await readFile(join(projectRoot, "viktor.space.json"), "utf8"),
    );
    if (descriptor?.auth?.mode === "public") return ["/"];
    return signedOut
      ? ["/", "/login", "/signup"]
      : ["/", "/dashboard", "/settings"];
  } catch {
    return ["/"];
  }
}

async function createReviewHelper(): Promise<PageHelper> {
  if (!signedOut) return await createPageHelper();
  const browser = await launchChromium();
  const context = await browser.newContext();
  return new PageHelper(await context.newPage(), browser, context);
}

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, colorScheme: "light" },
  { name: "tablet", width: 768, height: 1024, colorScheme: "light" },
  { name: "desktop", width: 1440, height: 900, colorScheme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
] as const;

// Viewports where axe runs (mobile + desktop cover both layouts and themes).
const AXE_VIEWPORTS = new Set(["mobile", "desktop", "desktop-dark"]);

const NEUTRAL_FONT_STACK = "ui-sans-serif";

interface PageResult {
  route: string;
  viewport: string;
  screenshot: string;
  horizontalOverflow: boolean;
  overflowOffenders: string[];
  consoleErrors: string[];
  axeViolations: {
    id: string;
    impact: string;
    description: string;
    nodes: number;
    examples: string[];
  }[];
  bodyFont: string;
  headingFont: string;
}

function slugify(route: string): string {
  return route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-");
}

async function scanSourceForHexColors(): Promise<HexFinding[]> {
  const findings: HexFinding[] = [];
  const srcDir = join(projectRoot, "src");
  const manifest = await readFile(
    join(projectRoot, "viktor.template.json"),
    "utf8",
  ).catch(() => null);
  const exempt = exemptSourceFiles(manifest);

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(entry.name)) continue;
      const file = relative(projectRoot, path).split(sep).join("/");
      if (exempt.has(file)) continue;

      findings.push(...hexColorFindings(file, await readFile(path, "utf8")));
    }
  }

  await walk(srcDir);
  return findings;
}

async function buildContactSheet(
  results: PageResult[],
  screenshotDir: string,
): Promise<string> {
  const routes = [...new Set(results.map(r => r.route))];
  const sections = routes
    .map(route => {
      const cells = results
        .filter(r => r.route === route)
        .map(
          r => `
            <figure>
              <img src="${pathToFileURL(join(screenshotDir, r.screenshot)).href}" alt="${r.route} ${r.viewport}" />
              <figcaption>${r.viewport} · ${
                r.horizontalOverflow ? "⚠ overflow" : "ok"
              }${r.axeViolations.length ? ` · ${r.axeViolations.length} axe` : ""}</figcaption>
            </figure>`,
        )
        .join("");
      return `<section><h2>${route}</h2><div class="row">${cells}</div></section>`;
    })
    .join("");

  const html = `<!doctype html>
<html><head><style>
  body { margin: 24px; font-family: system-ui, sans-serif; background: #f4f4f5; }
  h2 { font-size: 15px; margin: 20px 0 8px; }
  .row { display: flex; gap: 16px; align-items: flex-start; }
  figure { margin: 0; }
  figure img { display: block; border: 1px solid #d4d4d8; border-radius: 4px; }
  section .row img { max-height: 560px; width: auto; max-width: 640px; object-fit: contain; object-position: top; }
  figcaption { font-size: 11px; color: #52525b; padding-top: 4px; }
</style></head><body><h1 style="font-size:17px">Design review contact sheet</h1>${sections}</body></html>`;

  const sheetHtmlPath = join(screenshotDir, "contact-sheet.html");
  await writeFile(sheetHtmlPath, html);
  return sheetHtmlPath;
}

function renderReport(
  results: PageResult[],
  hexFindings: HexFinding[],
  neutralTypography: boolean,
  skippedRoutes: { route: string; redirectedTo: string }[],
): { markdown: string; blocking: string[] } {
  const blocking: string[] = [];
  const lines: string[] = ["# Design review report", ""];

  for (const s of skippedRoutes) {
    lines.push(
      `- ⚠️ skipped \`${s.route}\`: redirected to \`${s.redirectedTo}\` ` +
        `(route not reachable ${signedOut ? "signed out" : "signed in"}; review it ${signedOut ? "without" : "with"} --signed-out)`,
    );
  }
  if (skippedRoutes.length) lines.push("");

  for (const r of results) {
    lines.push(`## ${r.route} @ ${r.viewport}`);
    if (r.horizontalOverflow) {
      const offenders = r.overflowOffenders.length
        ? ` — wider than the viewport: ${r.overflowOffenders.join(", ")}`
        : "";
      blocking.push(`${r.route} @ ${r.viewport}: horizontal overflow`);
      lines.push(`- ❌ horizontal overflow${offenders}`);
    }
    for (const v of r.axeViolations) {
      const line = `axe ${v.id} (${v.impact}) — ${v.description} [${v.nodes} node(s)]`;
      if (v.impact === "serious" || v.impact === "critical") {
        blocking.push(`${r.route} @ ${r.viewport}: ${line}`);
        lines.push(`- ❌ ${line}`);
      } else {
        lines.push(`- ⚠️ ${line}`);
      }
      for (const example of v.examples) lines.push(`  - ${example}`);
    }
    for (const err of r.consoleErrors) {
      lines.push(`- ⚠️ console error: ${err.slice(0, 200)}`);
    }
    if (
      !r.horizontalOverflow &&
      r.axeViolations.length === 0 &&
      r.consoleErrors.length === 0
    ) {
      lines.push("- ✅ clean");
    }
    lines.push("");
  }

  lines.push("## Typography");
  const desktop = results.find(r => r.viewport === "desktop");
  if (desktop) {
    lines.push(`- body: \`${desktop.bodyFont}\``);
    lines.push(`- headings: \`${desktop.headingFont}\``);
  }
  if (neutralTypography) {
    lines.push(
      "- ⚠️ typography is still the neutral baseline (system stack). " +
        "Pick display/body fonts and set --font-display / --font-body — see DESIGN.md.",
    );
  }
  lines.push("");

  lines.push("## Token discipline");
  if (hexFindings.length === 0) {
    lines.push("- ✅ no hardcoded hex colors outside src/index.css");
  } else {
    for (const f of hexFindings) {
      blocking.push(`hardcoded color ${f.match} in ${f.file}:${f.line}`);
      lines.push(
        `- ❌ ${f.file}:${f.line} — \`${f.match}\` (move into tokens)`,
      );
    }
  }
  lines.push("");

  lines.push(
    blocking.length
      ? `**${blocking.length} blocking issue(s).** Fix and rerun.`
      : "**No blocking issues.** Now judge the contact sheet against DESIGN.md: does every screen carry the direction, or does it look like the neutral baseline?",
  );

  return { markdown: lines.join("\n"), blocking };
}

async function main() {
  const explicitRoutes = process.argv
    .slice(2)
    .filter(arg => arg !== "--signed-out");
  const routes = explicitRoutes.length ? explicitRoutes : await defaultRoutes();

  console.log("🚀 Starting preview server...");
  const server = await startPreviewServer();
  noteIgnoredAppUrl(server.url);

  let exitCode = 0;
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    process.env.APP_URL = server.url;
    const helper = await createReviewHelper();
    // A saved theme preference would override the emulated color scheme.
    await helper.page.addInitScript(() => localStorage.removeItem("theme"));
    const results: PageResult[] = [];

    const skippedRoutes: { route: string; redirectedTo: string }[] = [];

    routeLoop: for (const route of routes) {
      for (const viewport of VIEWPORTS) {
        await helper.page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        // The ThemeProvider defaults to the system preference, so emulating
        // the media query exercises the app's real dark theme.
        await helper.page.emulateMedia({ colorScheme: viewport.colorScheme });
        helper.clearConsoleLogs();
        await helper.goto(route);
        await helper.page.waitForTimeout(800);

        // Access-mode guards redirect unavailable routes (e.g. /dashboard in
        // a public-mode Space goes home). Skip instead of capturing the
        // landing page under a wrong label, which would misrepresent the app.
        const landedPath = new URL(helper.page.url()).pathname;
        if (landedPath !== route) {
          skippedRoutes.push({ route, redirectedTo: landedPath });
          console.warn(
            `skipping ${route}: redirected to ${landedPath} (route not available in this access mode)`,
          );
          continue routeLoop;
        }

        const screenshot = `${slugify(route)}--${viewport.name}.png`;
        await helper.page.screenshot({
          path: join(outDir, screenshot),
          fullPage: true,
        });

        const { horizontalOverflow, overflowOffenders, bodyFont, headingFont } =
          await helper.page.evaluate(() => {
            const doc = document.documentElement;
            const heading = document.querySelector("h1, h2, h3");
            const edge = doc.clientWidth + 1;
            const horizontalOverflow = doc.scrollWidth > edge;
            const scrollsItself = (el: Element) => {
              for (let a = el.parentElement; a; a = a.parentElement) {
                if (getComputedStyle(a).overflowX !== "visible") return true;
              }
              return false;
            };
            const overflowOffenders = (
              horizontalOverflow
                ? Array.from(document.body.querySelectorAll("*"))
                : []
            )
              .filter(el => {
                const parent = el.parentElement;
                return (
                  el.getBoundingClientRect().right > edge &&
                  !!parent &&
                  parent.getBoundingClientRect().right <= edge &&
                  !scrollsItself(el)
                );
              })
              .slice(0, 3)
              .map(el => {
                const classes = Array.from(el.classList).slice(0, 3);
                const name = [el.tagName.toLowerCase(), ...classes].join(".");
                const width = Math.round(el.getBoundingClientRect().right);
                return `\`${name}\` (right edge ${width}px)`;
              });
            return {
              horizontalOverflow,
              overflowOffenders,
              bodyFont: getComputedStyle(document.body).fontFamily,
              headingFont: heading
                ? getComputedStyle(heading).fontFamily
                : getComputedStyle(document.body).fontFamily,
            };
          });

        // Type specimen: crop the largest display-type block on the desktop
        // render so leading/tracking can be reviewed optically at natural
        // size (typesetting is judged by eye, not by the stylesheet).
        if (viewport.name === "desktop") {
          const specimen = await helper.page.evaluate(() => {
            let best: {
              x: number;
              y: number;
              width: number;
              height: number;
            } | null = null;
            let bestSize = 0;
            for (const el of Array.from(
              document.querySelectorAll("h1, h2, h3, p, span, div"),
            )) {
              if (!el.textContent || el.textContent.trim().length < 3) continue;
              if (el.children.length > 2) continue;
              const style = getComputedStyle(el);
              const size = Number.parseFloat(style.fontSize);
              if (!Number.isFinite(size) || size <= bestSize) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width < 40 || rect.height < 20) continue;
              bestSize = size;
              best = {
                x: rect.x + window.scrollX,
                y: rect.y + window.scrollY,
                width: rect.width,
                height: rect.height,
              };
            }
            return {
              box: best,
              page: {
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
              },
            };
          });
          const clip = specimen.box
            ? specimenClip(specimen.box, specimen.page)
            : null;
          if (clip) {
            await helper.page.screenshot({
              path: join(outDir, `specimen--${slugify(route)}.png`),
              fullPage: true,
              clip,
            });
          }
        }

        let axeViolations: PageResult["axeViolations"] = [];
        if (AXE_VIEWPORTS.has(viewport.name)) {
          const axe = await new AxeBuilder({ page: helper.page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          axeViolations = axe.violations.map(v => ({
            id: v.id,
            impact: v.impact ?? "minor",
            description: v.description,
            nodes: v.nodes.length,
            examples: v.nodes.slice(0, 3).map(n => {
              const why = (n.failureSummary ?? "")
                .split("\n")
                .slice(1)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              return `\`${n.target.join(" ")}\`${why ? `: ${why}` : ""}`;
            }),
          }));
        }

        results.push({
          route,
          viewport: viewport.name,
          screenshot,
          horizontalOverflow,
          overflowOffenders,
          consoleErrors: helper
            .getConsoleLogs()
            .filter(l => l.type === "error")
            .map(l => l.text),
          axeViolations,
          bodyFont,
          headingFont,
        });
        console.log(`📸 ${route} @ ${viewport.name}`);
      }
    }

    // Stitch the contact sheet by rendering a local gallery page.
    const sheetHtmlPath = await buildContactSheet(results, outDir);
    await helper.page.emulateMedia({ colorScheme: "light" });
    await helper.page.setViewportSize({ width: 2700, height: 1200 });
    await helper.page.goto(pathToFileURL(sheetHtmlPath).href, {
      waitUntil: "networkidle",
    });
    await helper.page.screenshot({
      path: join(outDir, "contact-sheet.png"),
      fullPage: true,
    });
    // Grayscale variant: the value-ladder check. If hierarchy doesn't read
    // here, no hue will save it (see the frontend_design color reference).
    await helper.page.addStyleTag({
      content: "img { filter: grayscale(1); }",
    });
    await helper.page.screenshot({
      path: join(outDir, "contact-sheet-gray.png"),
      fullPage: true,
    });
    await helper.close();

    const hexFindings = await scanSourceForHexColors();
    const indexCss = await readFile(
      join(projectRoot, "src", "index.css"),
      "utf8",
    );
    const neutralTypography =
      indexCss.includes(`--font-body:\n    ${NEUTRAL_FONT_STACK}`) ||
      indexCss.includes(`--font-body: ${NEUTRAL_FONT_STACK}`);

    const { markdown, blocking } = renderReport(
      results,
      hexFindings,
      neutralTypography,
      skippedRoutes,
    );
    await writeFile(join(outDir, "report.md"), markdown);
    await writeFile(
      join(outDir, "report.json"),
      JSON.stringify(
        { results, hexFindings, neutralTypography, blocking, skippedRoutes },
        null,
        2,
      ),
    );

    console.log(`\n${markdown}`);
    console.log(`\n📁 Artifacts: ${outDir}`);
    console.log("   - contact-sheet.png (review this against DESIGN.md)");
    console.log(
      "   - contact-sheet-gray.png (hierarchy must survive without color)",
    );
    console.log(
      "   - specimen--<route>.png (review display leading/tracking by eye)",
    );
    console.log("   - report.md / report.json");

    if (blocking.length > 0) exitCode = 1;
  } finally {
    // Always stop the preview: exiting inside the try would skip this and
    // leave the server running.
    await server.stop();
  }
  process.exit(exitCode);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
