// What a build reads, and the record each build leaves of which files those
// were. vite.config.ts and scripts/preview-server.ts both import this, so it
// may import only runtime built-ins.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

export const FRONTEND_BUILD_INPUTS = [
  "src",
  "public",
  "index.html",
  "vite.config.ts",
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "viktor.space.json",
  ".env.local",
  "scripts/space-access-mode.ts",
  "scripts/build-inputs.ts",
];
// The app's types come from Convex codegen, which only `sync` refreshes.
export const CONVEX_BUILD_INPUTS = ["convex"];
const UNWATCHED_DIRS = new Set(["_generated", "node_modules"]);
// Outside dist/, so it is never served or deployed.
const STAMP_PATH = join("tmp", "build-inputs.json");

export interface InputScan {
  files: string[];
  newer: string | null;
}

// Stops at the first file newer than `since`; `files` is complete only when
// none is.
export function scanInputs(
  root: string,
  inputs: string[],
  since = Number.POSITIVE_INFINITY,
): InputScan {
  const scan: InputScan = { files: [], newer: null };
  const visit = (path: string, isDirectory: boolean) => {
    if (scan.newer !== null) return;
    if (isDirectory) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && UNWATCHED_DIRS.has(entry.name)) continue;
        visit(join(path, entry.name), entry.isDirectory());
      }
      return;
    }
    const file = relative(root, path);
    scan.files.push(file);
    if (since === Number.POSITIVE_INFINITY) return;
    try {
      if (statSync(path).mtimeMs > since) scan.newer = file;
    } catch {}
  };
  for (const input of inputs) {
    if (scan.newer !== null) break;
    const path = join(root, input);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    visit(path, isDirectory);
  }
  return scan;
}

export function fileSetHash(files: string[]): string {
  return createHash("sha256")
    .update([...files].sort().join("\n"))
    .digest("hex");
}

export interface BuildInputsStamp {
  convex: string;
  frontend: string;
}

export function currentInputsStamp(root: string): BuildInputsStamp {
  return {
    convex: fileSetHash(scanInputs(root, CONVEX_BUILD_INPUTS).files),
    frontend: fileSetHash(scanInputs(root, FRONTEND_BUILD_INPUTS).files),
  };
}

function writeBuildInputsStamp(root: string, stamp: BuildInputsStamp): void {
  try {
    mkdirSync(join(root, "tmp"), { recursive: true });
    writeFileSync(join(root, STAMP_PATH), `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    console.warn(`⚠️  Could not record ${STAMP_PATH}: ${error}`);
  }
}

// Vite plugin: records the input set a build started from once it is written.
export function buildInputsStampPlugin(root: string) {
  let stamp: BuildInputsStamp | undefined;
  return {
    name: "viktor-build-inputs-stamp",
    apply: "build" as const,
    buildStart() {
      stamp = currentInputsStamp(root);
    },
    writeBundle() {
      if (stamp) writeBuildInputsStamp(root, stamp);
    },
  };
}

export function buildInputsStampTime(root: string): number | undefined {
  try {
    return statSync(join(root, STAMP_PATH)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function readBuildInputsStamp(root: string): BuildInputsStamp | null {
  try {
    const stamp = JSON.parse(readFileSync(join(root, STAMP_PATH), "utf8"));
    return typeof stamp?.convex === "string" &&
      typeof stamp?.frontend === "string"
      ? stamp
      : null;
  } catch {
    return null;
  }
}
