import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  ConsoleMessage,
  Page,
  Response as PageResponse,
} from "playwright";
import { chromium } from "playwright";
import { servedAccessMode } from "./space-access-mode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "tmp");

let publicSpace: boolean | undefined;

function isPublicSpace(): boolean {
  publicSpace ??= servedAccessMode(join(__dirname, "..")) === "public";
  return publicSpace;
}

async function openPublicApp(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  console.log(
    "[Auth] The served build is public (access mode: public): no sign-in",
  );
  const browser = await launchChromium();
  const context = await browser.newContext();
  return { browser, context, page: await context.newPage() };
}

const AUTH_STATE_MAX_AGE_MINUTES = 50;
const BROWSER_INSTALL_TIMEOUT_MS = 300_000;

type StorageState = Exclude<
  BrowserContextOptions["storageState"],
  string | undefined
>;

function getAppUrl(): string {
  return process.env.APP_URL || "http://localhost:5173";
}

function getTestId(): string {
  const scriptPath = process.argv[1] || "default";
  const name = basename(scriptPath, ".ts");
  const hash = createHash("md5").update(scriptPath).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function getAuthStatePath(): string {
  return join(TMP_DIR, `auth-state-${getTestId()}.json`);
}

export interface ConsoleLog {
  type: string;
  text: string;
  timestamp: Date;
  location?: string;
}

export interface PageDebugInfo {
  url: string;
  title: string;
  content: string;
  consoleLogs: ConsoleLog[];
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  selector?: string;
}

export class PageHelper {
  private consoleLogs: ConsoleLog[] = [];
  private consoleHandler: ((msg: ConsoleMessage) => void) | null = null;
  readonly edgeAccess: EdgeAccess;
  edgeAccessDeniedRetryDelayMs = 5_000;
  // The backend space-session id used to sign this helper in, revoked on close.
  spaceSessionSid?: string;

  constructor(
    public readonly page: Page,
    public readonly browser: Browser,
    public readonly context: BrowserContext,
  ) {
    this.edgeAccess = new EdgeAccess(context);
    this.setupConsoleCapture();
  }

  private setupConsoleCapture(): void {
    this.consoleHandler = (msg: ConsoleMessage) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date(),
        location: msg.location().url,
      });
    };
    this.page.on("console", this.consoleHandler);
  }

  getConsoleLogs(): ConsoleLog[] {
    return [...this.consoleLogs];
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  printConsoleLogs(): void {
    if (this.consoleLogs.length === 0) {
      console.log("\n📋 Console Logs: (none)\n");
      return;
    }
    console.log("\n📋 Console Logs:");
    console.log("─".repeat(60));
    for (const log of this.consoleLogs) {
      const icon =
        log.type === "error" ? "❌" : log.type === "warning" ? "⚠️" : "  ";
      console.log(`${icon} [${log.type.toUpperCase()}] ${log.text}`);
    }
    console.log("─".repeat(60));
  }

  async getPageContent(): Promise<string> {
    return await this.page.locator("body").innerText();
  }

  async printPageContent(): Promise<void> {
    const content = await this.getPageContent();
    console.log("\n📄 Page Content:");
    console.log("─".repeat(60));
    console.log(content || "(empty)");
    console.log("─".repeat(60));
  }

  async getDebugInfo(): Promise<PageDebugInfo> {
    return {
      url: this.page.url(),
      title: await this.page.title(),
      content: await this.getPageContent(),
      consoleLogs: this.getConsoleLogs(),
    };
  }

  async printDebugInfo(): Promise<void> {
    const info = await this.getDebugInfo();
    console.log("\n🔍 Debug Info:");
    console.log("─".repeat(60));
    console.log(`URL: ${info.url}`);
    console.log(`Title: ${info.title}`);
    console.log("─".repeat(60));
    await this.printPageContent();
    this.printConsoleLogs();
  }

  async screenshot(
    name?: string,
    options: ScreenshotOptions = {},
  ): Promise<string> {
    await mkdir(TMP_DIR, { recursive: true });
    const filename = name || `screenshot-${Date.now()}.png`;
    const path = join(TMP_DIR, filename);
    if (options.selector) {
      await this.page.locator(options.selector).first().screenshot({ path });
    } else {
      await this.page.screenshot({ path, fullPage: options.fullPage ?? true });
    }
    console.log(`📸 Screenshot saved: ${path}`);
    return path;
  }

  async goto(path: string): Promise<void> {
    const url = path.startsWith("http") ? path : `${getAppUrl()}${path}`;
    await this.edgeAccess.attach(url);
    const response = await this.page.goto(url, { waitUntil: "networkidle" });
    const status = response?.status();
    const gateDenied = status !== 401 && (await deniedByEdgeGate(response));
    if ((status === 401 || gateDenied) && this.edgeAccess.sends(url)) {
      this.edgeAccess.invalidate(url);
      if (gateDenied) {
        // After an access change a POP can serve the previous policy for a few seconds.
        await new Promise(resolve =>
          setTimeout(resolve, this.edgeAccessDeniedRetryDelayMs),
        );
      }
      await this.edgeAccess.attach(url);
      await this.page.goto(url, { waitUntil: "networkidle" });
    }
  }

  async close(): Promise<void> {
    await revokeSpaceSession(this.spaceSessionSid);
    await this.browser.close();
  }
}

// The gate answers a navigation it denies with a 302 to sign-in (a 403 when
// the policy has no sign-in rule), so the denial can sit in the redirect chain.
async function deniedByEdgeGate(
  response: PageResponse | null,
): Promise<boolean> {
  const denies = (answer: PageResponse) =>
    (answer.headers()["x-edge-gate-decision"] ?? "").startsWith("deny:");
  if (!response) return false;
  if (response.status() === 403 && denies(response)) return true;
  let request = response.request().redirectedFrom();
  while (request) {
    const redirect = await request.response();
    if (redirect && denies(redirect)) return true;
    request = request.redirectedFrom();
  }
  return false;
}

async function isAuthenticated(page: Page): Promise<boolean> {
  // If we're on /login or /signup, we're not authenticated
  const url = page.url();
  return !url.includes("/login") && !url.includes("/signup");
}

const SPACE_SESSION_TOKEN_KEY = "viktor_space_session_token";

interface MintedSpaceSession {
  session_token: string;
  sid?: string;
  cookie_name?: string;
  success?: boolean;
  error?: string;
}

function spaceAuthConfig(): {
  apiUrl: string;
  projectName: string;
  projectSecret: string;
  spaceId: string | undefined;
  toolToken: string;
} | null {
  const apiUrl = process.env.VIKTOR_SPACES_API_URL;
  const projectName = process.env.VIKTOR_SPACES_PROJECT_NAME;
  const projectSecret = process.env.VIKTOR_SPACES_PROJECT_SECRET;
  // Identifies this space across workspaces (project names are only unique
  // per owner); optional, the backend falls back to name + secret.
  const spaceId =
    process.env.VIKTOR_AUTH_RESOURCE_ID ||
    process.env.VITE_VIKTOR_SPACES_SPACE_ID ||
    undefined;
  const toolToken = process.env.TOOL_TOKEN;
  if (!apiUrl || !projectName || !projectSecret || !toolToken) {
    return null;
  }
  return { apiUrl, projectName, projectSecret, spaceId, toolToken };
}

// Ask the Viktor backend to mint a short-lived space session for this run. The
// tool token gates the mint, so an attacker who only has the space URL cannot
// obtain one.
async function mintSpaceSession(): Promise<MintedSpaceSession | null> {
  const config = spaceAuthConfig();
  if (!config) {
    return null;
  }
  const response = await fetch(
    `${config.apiUrl}/api/viktor-spaces/screenshot-auth-session`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.toolToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project_name: config.projectName,
        project_secret: config.projectSecret,
        space_id: config.spaceId,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Space session mint failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as MintedSpaceSession;
  if (!body.session_token) {
    throw new Error(body.error || "Space session mint failed");
  }
  return body;
}

// Best-effort revoke of a minted space session. The token also self-expires
// after a few minutes, so a missed revoke is not a lasting credential.
export async function revokeSpaceSession(
  sid: string | undefined,
): Promise<void> {
  if (!sid) {
    return;
  }
  const config = spaceAuthConfig();
  if (!config) {
    return;
  }
  try {
    await fetch(
      `${config.apiUrl}/api/viktor-spaces/screenshot-auth-session/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.toolToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_name: config.projectName,
          project_secret: config.projectSecret,
          space_id: config.spaceId,
          sid,
        }),
      },
    );
  } catch {
    // Best effort; the token self-expires.
  }
}

interface MintedEdgeAccess {
  success: boolean;
  header_name?: string;
  token?: string | null;
  expires_in_seconds?: number | null;
  error?: string | null;
}

interface EdgeAccessGrant {
  headers: Record<string, string>;
  expiresAtMs: number;
}

const EDGE_ACCESS_REFRESH_MARGIN_MS = 60_000;
const EDGE_ACCESS_DEFAULT_TTL_SECONDS = 600;
// A hostname that is not yet one of the Space's gated targets mints no token
// for now; ask again after this long.
const EDGE_ACCESS_NO_TOKEN_RETRY_MS = 30_000;

export async function edgeAccessHeaders(
  url: string,
): Promise<Record<string, string>> {
  return (await mintEdgeAccess(url)).headers;
}

async function mintEdgeAccess(url: string): Promise<EdgeAccessGrant> {
  const none = { headers: {}, expiresAtMs: Number.POSITIVE_INFINITY };
  const target = new URL(url);
  if (target.protocol !== "https:") return none;
  const config = spaceAuthConfig();
  if (!config) return none;
  const mintedAtMs = Date.now();
  const response = await fetch(
    `${config.apiUrl}/api/viktor-spaces/edge-access-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.toolToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project_name: config.projectName,
        project_secret: config.projectSecret,
        space_id: config.spaceId,
        url,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Edge access mint failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as MintedEdgeAccess;
  if (!body.success) {
    throw new Error(body.error || "Edge access mint failed");
  }
  if (!body.token || !body.header_name) {
    return {
      headers: {},
      expiresAtMs: mintedAtMs + EDGE_ACCESS_NO_TOKEN_RETRY_MS,
    };
  }
  const ttlSeconds = body.expires_in_seconds ?? EDGE_ACCESS_DEFAULT_TTL_SECONDS;
  return {
    headers: { [body.header_name]: body.token },
    expiresAtMs: mintedAtMs + ttlSeconds * 1000,
  };
}

// Only a successful mint is kept, and only until a minute before it expires;
// one without a token is kept 30 s, its host still routed so a later request
// can mint one. The header only rides on requests to that host, never to
// Convex or third parties.
export class EdgeAccess {
  private readonly grants = new Map<string, EdgeAccessGrant>();
  private readonly mints = new Map<string, Promise<EdgeAccessGrant>>();
  private readonly routedHosts = new Set<string>();

  constructor(private readonly context: BrowserContext) {}

  async attach(url: string): Promise<void> {
    const { host } = new URL(url);
    const grant = await this.grantFor(url);
    if (
      grant.expiresAtMs === Number.POSITIVE_INFINITY ||
      this.routedHosts.has(host)
    ) {
      return;
    }
    this.routedHosts.add(host);
    await this.context.route(
      requestUrl => requestUrl.host === host,
      async route => {
        const request = route.request();
        let current: Record<string, string> = {};
        try {
          current = (await this.grantFor(request.url())).headers;
        } catch (error) {
          console.error(
            "[Auth] Edge access re-mint failed:",
            error instanceof Error ? error.message : error,
          );
        }
        await route.continue({ headers: { ...request.headers(), ...current } });
      },
    );
  }

  sends(url: string): boolean {
    return this.routedHosts.has(new URL(url).host);
  }

  invalidate(url: string): void {
    this.grants.delete(new URL(url).host);
  }

  private async grantFor(url: string): Promise<EdgeAccessGrant> {
    const { host } = new URL(url);
    const grant = this.grants.get(host);
    const margin =
      grant && Object.keys(grant.headers).length > 0
        ? EDGE_ACCESS_REFRESH_MARGIN_MS
        : 0;
    if (grant && grant.expiresAtMs - Date.now() > margin) {
      return grant;
    }
    let mint = this.mints.get(host);
    if (!mint) {
      mint = mintEdgeAccess(url).finally(() => this.mints.delete(host));
      this.mints.set(host, mint);
    }
    const fresh = await mint;
    this.grants.set(host, fresh);
    return fresh;
  }
}

// Signs the page in by minting a backend space session and letting the app's
// SpaceSessionAutoSignIn bootstrap exchange it for a Convex Auth session. This
// works for every product auth provider config (email_password, viktor, or
// both). Returns the minted session id so the caller can revoke it on close.
export async function ensureTestUserExists(
  page: Page,
): Promise<string | undefined> {
  await page.goto(`${getAppUrl()}/login`, { waitUntil: "networkidle" });

  if (await isAuthenticated(page)) {
    console.log("[Auth] Already logged in");
    return undefined;
  }

  const session = await mintSpaceSession();
  if (!session) {
    throw new Error(
      "Cannot mint a space session for automated sign-in. Set VIKTOR_SPACES_API_URL, " +
        "VIKTOR_SPACES_PROJECT_NAME, VIKTOR_SPACES_PROJECT_SECRET, and TOOL_TOKEN " +
        "(present in a deployed space's .env.local).",
    );
  }

  console.log("[Auth] Signing in via a minted space session...");
  await page.evaluate(
    ([key, token]) => {
      try {
        sessionStorage.setItem(key, token);
      } catch {
        // sessionStorage unavailable; the reload below will surface the failure.
      }
    },
    [SPACE_SESSION_TOKEN_KEY, session.session_token] as const,
  );
  await page.reload({ waitUntil: "networkidle" });

  for (let attempt = 0; attempt < 15; attempt++) {
    if (await isAuthenticated(page)) {
      console.log("[Auth] Signed in successfully");
      return session.sid;
    }
    await page.waitForTimeout(1000);
  }

  await mkdir(TMP_DIR, { recursive: true });
  await page.screenshot({ path: join(TMP_DIR, "auth-debug.png") });
  const content = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  console.log("[Auth] Page content after sign-in attempt:", content);
  await revokeSpaceSession(session.sid);
  throw new Error(
    "Failed to sign in via space session - Dashboard not visible",
  );
}

// Back-compat alias for scripts that imported the old name.
export async function signInTestUser(page: Page): Promise<string | undefined> {
  return ensureTestUserExists(page);
}

export async function saveAuthState(page: Page): Promise<void> {
  await mkdir(TMP_DIR, { recursive: true });
  const authStatePath = getAuthStatePath();
  const context = page.context();
  await context.storageState({ path: authStatePath });
  console.log(`[Auth] Auth state saved to ${authStatePath}`);
}

export async function loadAuthState(): Promise<StorageState | undefined> {
  const authStatePath = getAuthStatePath();

  if (!existsSync(authStatePath)) {
    return undefined;
  }

  try {
    const stats = statSync(authStatePath);
    const ageMinutes = (Date.now() - stats.mtimeMs) / 1000 / 60;

    if (ageMinutes > AUTH_STATE_MAX_AGE_MINUTES) {
      console.log(
        `[Auth] Auth state expired (${ageMinutes.toFixed(0)}m old, max ${AUTH_STATE_MAX_AGE_MINUTES}m), will re-authenticate`,
      );
      unlinkSync(authStatePath);
      return undefined;
    }

    console.log(
      `[Auth] Loading auth state from ${authStatePath} (${ageMinutes.toFixed(0)}m old)`,
    );
    const state: StorageState = JSON.parse(readFileSync(authStatePath, "utf8"));
    const origin = new URL(getAppUrl()).origin;
    for (const entry of state.origins) entry.origin = origin;
    return state;
  } catch {
    return undefined;
  }
}

export function clearAllAuthStates(): void {
  if (!existsSync(TMP_DIR)) return;

  const files = readdirSync(TMP_DIR);
  let cleared = 0;

  for (const file of files) {
    if (file.startsWith("auth-state-") && file.endsWith(".json")) {
      try {
        unlinkSync(join(TMP_DIR, file));
        cleared++;
      } catch {}
    }
  }

  if (cleared > 0) {
    console.log(`[Auth] Cleared ${cleared} auth state file(s)`);
  }
}

// The sandbox image ships the Chromium build of the Playwright release that
// was current when the image was built; this project's lockfile can pin a
// different release.
export async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/Executable doesn't exist|playwright install/i.test(error.message)
    ) {
      throw error;
    }
    console.log(
      "[Browser] Installing the Chromium build this project's Playwright expects...",
    );
    const projectRoot = join(__dirname, "..");
    execFileSync(
      join(projectRoot, "node_modules", ".bin", "playwright"),
      ["install", "chromium-headless-shell"],
      {
        cwd: projectRoot,
        stdio: "inherit",
        timeout: BROWSER_INSTALL_TIMEOUT_MS,
      },
    );
    return await chromium.launch();
  }
}

export async function createAuthenticatedBrowser(): Promise<{
  browser: Browser;
  page: Page;
}> {
  if (isPublicSpace()) {
    const { browser, page } = await openPublicApp();
    await page.goto(`${getAppUrl()}/`, { waitUntil: "networkidle" });
    return { browser, page };
  }
  const storageState = await loadAuthState();
  const browser = await launchChromium();
  const context = await browser.newContext(
    storageState ? { storageState } : {},
  );
  await new EdgeAccess(context).attach(getAppUrl());
  const page = await context.newPage();

  // Check auth by going to login - if we get redirected, we're authenticated
  await page.goto(`${getAppUrl()}/login`, { waitUntil: "networkidle" });

  if (!(await isAuthenticated(page))) {
    await ensureTestUserExists(page);
    await saveAuthState(page);
  }

  return { browser, page };
}

export async function createPageHelper(): Promise<PageHelper> {
  if (isPublicSpace()) {
    const { browser, context, page } = await openPublicApp();
    // Constructed before the first load so its console output is captured.
    const helper = new PageHelper(page, browser, context);
    await helper.goto("/");
    return helper;
  }
  const storageState = await loadAuthState();
  const browser = await launchChromium();
  const context = await browser.newContext(
    storageState ? { storageState } : {},
  );
  const page = await context.newPage();

  const helper = new PageHelper(page, browser, context);
  await helper.edgeAccess.attach(getAppUrl());

  // Check auth by going to login - if we stay on login, we need to authenticate
  await page.goto(`${getAppUrl()}/login`, { waitUntil: "networkidle" });

  if (!(await isAuthenticated(page))) {
    // Not authenticated - log in
    helper.spaceSessionSid = await ensureTestUserExists(page);
    await saveAuthState(page);
  }

  // Navigate to root - test can go wherever it needs from here
  await page.goto(`${getAppUrl()}/`, { waitUntil: "networkidle" });

  return helper;
}

async function fetchConvexLogs(maxLines = 30): Promise<string> {
  return new Promise(resolve => {
    const logs: string[] = [];
    const proc = spawn(
      "bunx",
      ["convex", "logs", "--history", String(maxLines), "--success"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: `${dirname(fileURLToPath(import.meta.url))}/..`,
      },
    );

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        if (line.trim() && !line.startsWith("Watching logs")) {
          logs.push(line);
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      if (
        !text.includes("WebSocket") &&
        !text.includes("Attempting reconnect")
      ) {
        logs.push(`[stderr] ${text.trim()}`);
      }
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(logs.length > 0 ? logs.join("\n") : "(No recent log entries)");
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve(logs.length > 0 ? logs.join("\n") : "(No recent log entries)");
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve("(Failed to fetch Convex logs)");
    });
  });
}

export async function runTest(
  testName: string,
  testFn: (helper: PageHelper) => Promise<void>,
): Promise<void> {
  console.log(`\n🧪 Running: ${testName}\n`);

  let helper: PageHelper | undefined;

  try {
    helper = await createPageHelper();
    await testFn(helper);
    console.log(`\n✅ ${testName} PASSED\n`);
  } catch (error) {
    console.error(`\n❌ ${testName} FAILED\n`);
    console.error("Error:", error instanceof Error ? error.message : error);

    if (!helper) {
      console.error(
        isPublicSpace()
          ? "The browser launch or the first page load failed before the test body ran."
          : "The browser launch or test sign-in failed before the test body ran.",
      );
      throw error;
    }

    try {
      await helper.screenshot(`error-${Date.now()}.png`);
      await helper.printDebugInfo();

      console.log("\n🔧 Convex Backend Logs:");
      console.log("─".repeat(60));
      const convexLogs = await fetchConvexLogs();
      console.log(convexLogs);
      console.log("─".repeat(60));
    } catch (debugError) {
      console.error("Failed to capture debug info:", debugError);
    }

    throw error;
  } finally {
    if (helper) {
      if (!isPublicSpace()) {
        try {
          await saveAuthState(helper.page);
        } catch {}
      }
      await helper.close();
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` &&
  process.argv[2] === "edge-header"
) {
  (async () => {
    const url = process.argv[3];
    if (!url) throw new Error("Usage: bun scripts/auth.ts edge-header <url>");
    for (const [name, value] of Object.entries(await edgeAccessHeaders(url))) {
      console.log(`${name}: ${value}`);
    }
  })().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    console.log("Setting up test user authentication...");
    const helper = await createPageHelper();
    console.log("Test user is ready!");
    await helper.printDebugInfo();
    await helper.close();
  })().catch(console.error);
}
