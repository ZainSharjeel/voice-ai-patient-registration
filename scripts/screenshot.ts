import { createPageHelper } from "./auth";
import { noteIgnoredAppUrl, startPreviewServer } from "./preview-server";

const USAGE =
  "Usage: bun run screenshot [path] [filename] [--selector <css>] [--viewport-only]";

function parseArgs(argv: string[]): {
  path: string;
  filename: string;
  selector?: string;
  fullPage: boolean;
} {
  const positional: string[] = [];
  let selector: string | undefined;
  let fullPage = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--viewport-only") {
      fullPage = false;
    } else if (arg === "--selector") {
      selector = argv[++i];
      if (!selector) throw new Error(`--selector needs a value. ${USAGE}`);
    } else if (arg.startsWith("--selector=")) {
      selector = arg.slice("--selector=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag ${arg}. ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  return {
    path: positional[0] || "/",
    filename: positional[1] || `screenshot-${Date.now()}.png`,
    selector,
    fullPage,
  };
}

async function main() {
  const { path, filename, selector, fullPage } = parseArgs(
    process.argv.slice(2),
  );

  console.log("🚀 Starting preview server...");
  const server = await startPreviewServer();
  noteIgnoredAppUrl(server.url);

  try {
    console.log(`📸 Taking screenshot of ${path}...\n`);

    process.env.APP_URL = server.url;
    const helper = await createPageHelper();

    await helper.goto(path);
    await helper.screenshot(filename, { fullPage, selector });

    console.log(`\n📍 URL: ${helper.page.url()}`);
    await helper.printPageContent();
    helper.printConsoleLogs();

    await helper.close();
    console.log("\n✅ Done!");
  } finally {
    await server.stop();
  }
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
