import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noteIgnoredAppUrl, startPreviewServer } from "./preview-server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const MISSING_BROWSER_MARKER = "Executable doesn't exist";

async function browserLaunchError(): Promise<string | null> {
  const { chromium } = await import("playwright");
  try {
    const browser = await chromium.launch();
    await browser.close();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// The sandbox does not always hold the browser build this project's pinned
// Playwright launches, so install it with the project's own Playwright CLI
// (a bare `bunx playwright` outside the project fetches a different build).
async function ensurePlaywrightBrowser(): Promise<void> {
  const launchError = await browserLaunchError();
  if (!launchError?.includes(MISSING_BROWSER_MARKER)) return;

  console.log("📦 Installing the Playwright browser this project needs...");
  const exitCode = await new Promise<number>(done => {
    const install = spawn(
      join(projectRoot, "node_modules", ".bin", "playwright"),
      ["install", "chromium-headless-shell"],
      { cwd: projectRoot, stdio: "inherit" },
    );
    install.on("close", code => done(code ?? 1));
    install.on("error", () => done(1));
  });
  if (exitCode !== 0) {
    console.error(
      "❌ Playwright browser install failed. Run `bunx playwright install chromium-headless-shell` in the project folder, then re-run the test.",
    );
    process.exit(1);
  }
}

interface TestResult {
  file: string;
  exitCode: number;
}

function getTestLabel(testFile: string): string {
  const name = testFile.replace(/^scripts\//, "").replace(/\.ts$/, "");
  return name.length > 20 ? `${name.slice(0, 17)}...` : name.padEnd(20);
}

async function runTest(testFile: string, appUrl: string): Promise<TestResult> {
  return new Promise(resolve => {
    const testPath = testFile.startsWith("/")
      ? testFile
      : join(projectRoot, testFile);

    const label = getTestLabel(testFile);
    console.log(`🧪 [${label}] Starting`);

    // --no-orphans: a crashed test cannot leave Playwright's Chromium behind.
    const test = spawn("bun", ["--no-orphans", "run", "--bun", testPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APP_URL: appUrl,
      },
    });

    test.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[${label}] ${line}`);
        }
      }
    });

    test.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.error(`[${label}] ${line}`);
        }
      }
    });

    test.on("close", code => {
      resolve({ file: testFile, exitCode: code ?? 1 });
    });

    test.on("error", err => {
      console.error(`[${label}] Failed to run:`, err);
      resolve({ file: testFile, exitCode: 1 });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: bun run test <test-file.ts> [test-file2.ts ...]");
    console.log("Example: bun run test scripts/board-test.ts");
    console.log("\nThis script:");
    console.log(
      "  1. Rebuilds dist/ when it is missing or older than the sources (`build`, or `sync:build` after convex/ changes)",
    );
    console.log(
      "  2. Starts the Vite preview server (serves built files; port 4173, or a free one if taken)",
    );
    console.log("  3. Waits for it to be ready");
    console.log("  4. Runs your test file(s) with APP_URL set correctly");
    console.log("  5. Stops the server when done");
    process.exit(1);
  }

  await ensurePlaywrightBrowser();

  console.log("🚀 Starting preview server...");
  const server = await startPreviewServer({
    onOutput: (line, stream) =>
      stream === "stderr"
        ? console.error(`[preview] ${line}`)
        : console.log(`[preview] ${line}`),
  });
  noteIgnoredAppUrl(server.url);
  console.log(`✅ Server is ready at ${server.url}\n`);

  let exitCode = 0;
  try {
    const results = await Promise.all(
      args.map(testFile => runTest(testFile, server.url)),
    );

    for (const result of results) {
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
        console.error(`\n❌ Test failed: ${result.file}`);
      } else {
        console.log(`\n✅ Test passed: ${result.file}`);
      }
    }
  } finally {
    console.log("\n🛑 Stopping preview server...");
    await server.stop();
  }

  if (exitCode === 0) {
    console.log("\n✅ All tests passed!");
  } else {
    console.log("\n❌ Some tests failed");
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
