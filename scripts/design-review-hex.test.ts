import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exemptSourceFiles, hexColorFindings } from "./design-review-hex";

const projectRoot = join(import.meta.dir, "..");

test("a fresh template passes the token check: managed files are exempt", () => {
  const exempt = exemptSourceFiles(
    readFileSync(join(projectRoot, "viktor.template.json"), "utf8"),
  );
  expect(exempt.has("src/components/ViktorSpacePreviewBadge.tsx")).toBe(true);

  const findings = readdirSync(join(projectRoot, "src"), { recursive: true })
    .map(entry => `src/${String(entry)}`)
    .filter(file => /\.(tsx?|css)$/.test(file) && !exempt.has(file))
    .flatMap(file =>
      hexColorFindings(file, readFileSync(join(projectRoot, file), "utf8")),
    );
  expect(findings).toEqual([]);
});

test("app code with a hardcoded color is still flagged", () => {
  expect(
    hexColorFindings(
      "src/pages/Home.tsx",
      'const x = 1;\n<div className="bg-[#1B182A]" />',
    ),
  ).toEqual([{ file: "src/pages/Home.tsx", line: 2, match: "#1B182A" }]);
});

test("comment lines are skipped", () => {
  expect(hexColorFindings("src/a.ts", "  // brand blue #150079")).toEqual([]);
});

test("a missing template manifest exempts only the token file", () => {
  expect([...exemptSourceFiles(null)]).toEqual(["src/index.css"]);
});
