import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInputsStampTime,
  CONVEX_BUILD_INPUTS,
  FRONTEND_BUILD_INPUTS,
  fileSetHash,
  readBuildInputsStamp,
  scanInputs,
} from "./build-inputs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function newestFileMtime(dir: string): number | undefined {
  let newest: number | undefined;
  for (const name of readdirSync(dir)) {
    const mtime = mtimeMs(join(dir, name));
    if (mtime !== undefined && (newest === undefined || mtime > newest)) {
      newest = mtime;
    }
  }
  return newest;
}

// With dist/ gone, the last build's input record (or, before any recorded
// build, the codegen output) stands in for its time and file set.
function convexChangedWithoutDist(root: string): boolean {
  const generated = join(root, "convex", "_generated");
  if (!existsSync(generated)) return true;
  const since = buildInputsStampTime(root) ?? newestFileMtime(generated);
  if (since === undefined) return true;
  const convex = scanInputs(root, CONVEX_BUILD_INPUTS, since);
  if (convex.newer) return true;
  const stamp = readBuildInputsStamp(root);
  return stamp !== null && stamp.convex !== fileSetHash(convex.files);
}

export type BuildState =
  | { fresh: true }
  | { fresh: false; reason: string; script: "build" | "sync:build" };

export function checkBuild(root: string = projectRoot): BuildState {
  const builtAt = mtimeMs(join(root, "dist", "index.html"));
  if (builtAt === undefined) {
    return {
      fresh: false,
      reason: "dist/ has no build",
      script: convexChangedWithoutDist(root) ? "sync:build" : "build",
    };
  }
  const convex = scanInputs(root, CONVEX_BUILD_INPUTS, builtAt);
  if (convex.newer) {
    return {
      fresh: false,
      reason: `${convex.newer} changed after the last build`,
      script: "sync:build",
    };
  }
  // Deletions and renames leave no newer file; the file set shows them.
  // Builds without a stamp (older vite.config.ts) fall back to mtimes alone.
  // Convex is settled first: its changes need sync:build whatever else changed.
  const stamp = readBuildInputsStamp(root);
  if (stamp && stamp.convex !== fileSetHash(convex.files)) {
    return {
      fresh: false,
      reason:
        "files under convex/ were added, removed or renamed since the last build",
      script: "sync:build",
    };
  }
  const frontend = scanInputs(root, FRONTEND_BUILD_INPUTS, builtAt);
  if (frontend.newer) {
    return {
      fresh: false,
      reason: `${frontend.newer} changed after the last build`,
      script: "build",
    };
  }
  if (stamp && stamp.frontend !== fileSetHash(frontend.files)) {
    return {
      fresh: false,
      reason:
        "source files were added, removed or renamed since the last build",
      script: "build",
    };
  }
  return { fresh: true };
}

export async function ensureFreshBuild(
  root: string = projectRoot,
): Promise<void> {
  const state = checkBuild(root);
  if (state.fresh) return;
  console.log(
    `🔨 ${state.reason}; running \`bun run ${state.script}\` before serving it.`,
  );
  const exitCode = await new Promise<number>(done => {
    const build = spawn("bun", ["run", state.script], {
      cwd: root,
      stdio: "inherit",
    });
    build.on("close", code => done(code ?? 1));
    build.on("error", () => done(1));
  });
  if (exitCode !== 0) {
    throw new Error(
      `\`bun run ${state.script}\` failed (exit ${exitCode}); fix the errors above and re-run.`,
    );
  }
}

// Saved test auth state is keyed by origin, so 4173 is kept whenever it is free.
export const PREFERRED_PREVIEW_PORT = 4173;
// A plain `vite preview` on `localhost` binds only one loopback family (often
// ::1), so another vite can still bind the other one on the same port and
// `localhost` then reaches whichever answers first. Binding and browsing one
// explicit address keeps the runner on its own server.
const PREVIEW_HOST = "127.0.0.1";
const FALLBACK_PORT_SCAN = 50;
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 300;
const MAX_START_ATTEMPTS = 3;

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise(done => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      // No IPv6 loopback on this host: nothing can hold the port there.
      done(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT");
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => done(true));
    });
  });
}

// Free on both families, so `localhost:<port>` is unambiguous for a person too.
export async function isPortFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    canListen(port, "127.0.0.1"),
    canListen(port, "::1"),
  ]);
  return v4 && v6;
}

export async function choosePreviewPort(
  isFree: (port: number) => Promise<boolean> = isPortFree,
  exclude: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let offset = 0; offset <= FALLBACK_PORT_SCAN; offset++) {
    const port = PREFERRED_PREVIEW_PORT + offset;
    if (!exclude.has(port) && (await isFree(port))) return port;
  }
  throw new Error(
    `No free preview port in ${PREFERRED_PREVIEW_PORT}-${PREFERRED_PREVIEW_PORT + FALLBACK_PORT_SCAN}`,
  );
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function announcedPort(output: string): number | null {
  const match = output
    .replace(ANSI_PATTERN, "")
    .match(/Local:\s+https?:\/\/[^\s/]+:(\d+)/);
  return match ? Number(match[1]) : null;
}

export interface PreviewServer {
  url: string;
  stop(): Promise<void>;
}

export interface StartPreviewOptions {
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
}

type Attempt =
  | { status: "ready"; server: PreviewServer }
  | { status: "exited"; output: string };

function attemptStart(
  port: number,
  { onOutput }: StartPreviewOptions,
): Promise<Attempt> {
  const url = `http://${PREVIEW_HOST}:${port}`;
  // --no-orphans: if this runner dies (even SIGKILL), the vite preview tree
  // dies with it instead of squatting on the port.
  const child = spawn(
    "bun",
    [
      "--no-orphans",
      "run",
      "preview",
      "--host",
      PREVIEW_HOST,
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], detached: false },
  );
  let output = "";
  let exited = false;
  let stopping = false;
  const exitedPromise = new Promise<void>(done => {
    child.once("exit", () => {
      exited = true;
      done();
    });
    child.once("error", error => {
      output += `${error.message}\n`;
      exited = true;
      done();
    });
  });

  const capture = (stream: "stdout" | "stderr") => (data: Buffer) => {
    const text = data.toString();
    output += text;
    // `bun run` reports the SIGTERM we send as an error; it is not one.
    if (stopping) return;
    for (const line of text.split("\n")) {
      if (line.trim()) onOutput?.(line.trimEnd(), stream);
    }
  };
  child.stdout?.on("data", capture("stdout"));
  child.stderr?.on("data", capture("stderr"));

  const server: PreviewServer = {
    url,
    async stop() {
      if (exited) return;
      stopping = true;
      child.kill("SIGTERM");
      await Promise.race([
        exitedPromise,
        new Promise(r => setTimeout(r, 2000)),
      ]);
    },
  };

  return (async (): Promise<Attempt> => {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline && !exited) {
      // Only our own vite's banner proves the port is ours; a response alone
      // could come from another Space's preview.
      if (announcedPort(output) === port) {
        try {
          const response = await fetch(url);
          if (!exited && (response.ok || response.status === 304)) {
            return { status: "ready", server };
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    await server.stop();
    return {
      status: "exited",
      output: exited ? output : `${output}\n(timed out after ${MAX_WAIT_MS}ms)`,
    };
  })();
}

export async function startPreviewServer(
  options: StartPreviewOptions = {},
): Promise<PreviewServer> {
  await ensureFreshBuild();
  const tried = new Set<number>();
  let lastOutput = "";
  for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
    const port = await choosePreviewPort(isPortFree, tried);
    tried.add(port);
    if (port !== PREFERRED_PREVIEW_PORT) {
      console.log(
        `ℹ️  Port ${PREFERRED_PREVIEW_PORT} is in use (likely another Space's preview); using ${port}.`,
      );
    }
    const result = await attemptStart(port, options);
    if (result.status === "ready") return result.server;
    lastOutput = result.output;
    if (!/already in use|EADDRINUSE/i.test(result.output)) break;
  }
  throw new Error(
    `Preview server failed to start. Run 'bun run sync:build' first.\n${lastOutput.trim()}`,
  );
}

export function noteIgnoredAppUrl(previewUrl: string): void {
  const given = process.env.APP_URL;
  if (given && given !== previewUrl) {
    console.log(
      `ℹ️  APP_URL=${given} is ignored: this command always runs against the local preview build (${previewUrl}), not a deployed app.`,
    );
  }
}
