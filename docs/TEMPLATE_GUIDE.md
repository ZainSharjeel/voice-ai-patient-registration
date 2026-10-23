# Viktor Space: application starter

Convex + Vite + React 19 + Tailwind CSS v4 + Base UI, with working auth and
unstyled pages. Init already provisioned the Convex dev and prod
deployments, auth and email, and wrote the app name (`src/lib/constants.ts`,
`convex/constants.ts`), page title and description (`index.html`) and favicon.

**Before building UI, use the shared `frontend_design` skill and read
`DESIGN.md`.** The starter's pages work but carry no design; design the
screens, navigation and layout for this app's users and tasks.

## Build loop

```bash
bun run sync:build                        # push Convex functions to dev, typecheck, build
bun run test scripts/<feature>-test.ts    # e2e against the build, already signed in
bun run design:review                     # screenshots at 4 viewports + blocking checks
bun run logs:fetch                        # recent Convex logs, exits after 5 s
```

Run `sync:build` after every change before testing. `bunx convex dev` and
`bun run dev` watch forever; use the one-shot commands above. Deploy only with
the `deploy_app` tool.

| Command | Does |
| --- | --- |
| `bun run sync` | Push Convex functions once, no build |
| `bun run test <files…>` | Install the pinned browser if missing, rebuild `dist/` when a source is newer (`sync:build` when `convex/` changed; `screenshot` and `design:review` do the same), start `vite preview` (4173, or a free port when another Space's preview holds it), run each test against it, stop; an `APP_URL` you set is ignored |
| `bun run design:review [--signed-out] [routes…]` | Default `/`, plus `/dashboard` and `/settings` in authenticated apps (`/login` and `/signup` with `--signed-out`); see "Design Review" |
| `bun run screenshot [path] [file] [--selector <css>] [--viewport-only]` | Signed-in screenshot into `tmp/`: the full page, one element, or the viewport |
| `bun run check` / `format` / `lint` | Biome |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run logs` | Stream Convex logs (does not exit) |
| `bun run test:auth` | Sign the test browser in once and print the session's debug info |

## Where things go

`viktor.space.json` decides which route tree runs: `auth.mode: "authenticated"`
uses `src/auth/authenticated/AuthenticatedAppRoutes.tsx`, `"public"` uses
`src/auth/public/PublicAppRoutes.tsx`.

**Authenticated apps**

| Route | Page (`src/pages/`) | Rendered inside | Notes |
| --- | --- | --- | --- |
| `/` | `LandingPage` | `PublicLayout` | Public entry: app name, a Sign in or Open app link, and Create an account in email/password apps. Members who lose access are sent here. An internal tool with no public page returns `<Navigate to="/dashboard" replace />`; the guard sends signed-out visitors to `/login`. |
| `/dashboard` | `DashboardPage` | `ProtectedRoute` → `AppLayout` | Signed-in home: sign-in, automatic Viktor sign-in and the OAuth return land here unless the visitor opened a deeper link (fixed in the managed auth code). Starts as a heading; make it the app's main screen. |
| `/settings` | `SettingsPage` (`SettingsPage.tsx`) | `ProtectedRoute` → `AppLayout` | Working account page: sign out, theme, password change (email/password apps only), account deletion. Restyle it and keep its actions. `api.users.deleteAccount` removes only the sign-in records, so delete the user's app rows in your own mutation first. |
| `/login`, `/signup`, `/auth/callback` | managed | `PublicLayout` (login, signup) | Working forms whose controls take their classes from `controlStyles.ts`. For another layout, export your own `LoginPage`/`SignupPage` from `index.tsx` that composes `SignIn`, `SignUp` and `ViktorSignInSection` as the managed pages do (including their no-provider message); leave the managed files as they are. |

- Add routes in `AuthenticatedAppRoutes.tsx`: signed-in screens inside the
  `<AppLayout />` route, public pages inside `<PublicLayout />`.
- `src/components/AppLayout.tsx` renders an unstyled bar (app name, signed-in
  email, Settings, Sign out) above each signed-in page. Replace it with the
  app's shell (header, navigation, account menu) and keep Settings and Sign out
  reachable; each page renders its own `<main>`.
- `PublicLayout.tsx` is a bare `<Outlet />` that also wraps the full-height
  login and signup pages, so a marketing header belongs in `LandingPage`.

**Public apps** (`auth.mode: "public"`): `/` is
`src/pages/PublicLandingPage.tsx`; add routes in `PublicAppRoutes.tsx` and the
site header in `src/components/PublicHeader.tsx`. That shell already renders
`<main>`, so pages return their sections without another `<main>`.

**Managed files.** `viktor.template.json` lists the platform-owned files (auth,
access, sign-in pages, the preview badge, `scripts/auth.ts`). Template
upgrades replace or merge them, so change them only for a deliberate auth
change. Adding your routes to `AuthenticatedAppRoutes.tsx` is expected; upgrades
merge around them.

## UI foundation

- **Tokens**: `src/index.css` holds the light and dark colors (OKLCH), `--radius`,
  and `--font-body` / `--font-display`. For fonts, `bun add
  @fontsource-variable/<family>`, import it in `src/main.tsx`, and point the
  tokens at it.
- **Controls**: `src/ui/` holds almost headless helpers (`Button`, `Input`,
  `Label`, `Dialog`, `Menu`, `Popover`, `Switch`, …) imported from `@/ui`;
  `src/components/controlStyles.ts` holds the app's button and input classes,
  which the managed sign-in forms use too; restyle them there.
  For more behavior import `@base-ui/react/<component>` and read
  `https://base-ui.com/react/components/<component>.md`.
- **Theme**: `ThemeProvider` in `App.tsx` takes `defaultTheme` (`"system"`,
  `"light"`, `"dark"`) and `switchable`; `useTheme()` returns `theme`,
  `toggleTheme` and `switchable`.
- **Installed**: react-router v8 (import from `"react-router"`),
  react-hook-form + zod, lucide-react, recharts, date-fns, framer-motion, and
  Sonner (`toast` from `"sonner"`; the `<Toaster />` is mounted). Hooks:
  `useIsMobile()` (`@/hooks/use-mobile`, under 768px), `useComposition()` for
  IME-safe Enter handling, `usePersistFn()`.
- Import with the `@/` alias (`@/ui`, `@/lib/utils` for `cn()`).

## Modules

Optional features are modules Viktor adds and removes with `add_space_module`
and `remove_space_module`. Each lives in `src/modules/<name>/` with a
`MODULE.md`, mounts through `src/modules/registry.ts` and the `<ModuleOutlet />`
in `App.tsx` without app edits, and is imported as `@/modules/<name>/…`. To make
the app installable to a home screen or dock, add `pwa-install`; add no service
worker, since cached pages would outlive sign-outs, access changes and
redeploys.

## Design Review

```bash
bun run design:review                    # default routes
bun run design:review /dashboard /reports
bun run design:review --signed-out       # as a visitor: /, /login, /signup
```

The browser is signed in, so `/login` and `/signup` redirect; `--signed-out`
reviews as a visitor, so signed-in routes redirect. Routes that redirect are
skipped with a warning. Output in `tmp/design-review/latest/` (`signed-out/`):
screenshots at mobile, tablet, desktop and desktop-dark, `contact-sheet.png`,
a grayscale sheet, type specimens and `report.md`. It exits non-zero on
horizontal overflow (naming the elements that cross the edge), serious or
critical axe violations, and hex colors in `src/` outside `src/index.css` and
the managed files. The checks are the floor: judge the contact sheet against
`DESIGN.md`.

## Protecting Convex Functions

Authentication is enforced inside each Convex function, not by `auth.mode`, a
frontend route guard, or the Viktor edge access gate. In authenticated Spaces,
define app-facing functions with `authenticatedQuery`,
`authenticatedMutation`, and `authenticatedAction` from `convex/functions.ts`.
They reject anonymous calls to the public Convex API and add the verified
Convex Auth user ID to `ctx.userId`.

Use raw `query`, `mutation`, and `action` builders only for deliberately public
endpoints. Use `internalQuery`, `internalMutation`, and `internalAction` for
server-only work. Authentication identifies the caller; every function must
still verify that `ctx.userId` may access or modify the requested record.

Authenticated is not authorized: `authenticatedQuery` accepts any signed-in
user, including anyone who can sign up. For sensitive data, restrict who may
sign up ([domain restriction](#internal-apps-domain-restriction) or the
providers in `viktor.space.json`) or check membership/roles in the function.

For a one-off data change in production (backfill, fix a record), write an
`internalMutation` and run it with
`run_app_function(project_name, "module:fn", args, environment="prod")`.
Never ship a public mutation or a secret-gated HTTP route for it.

## Users and Sign-in

```tsx
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const user = useQuery(api.auth.currentUser); // users row, null when signed out
const { signOut } = useAuthActions();
```

Sign-in methods come from `auth.providers` in `viktor.space.json`: "Sign in
with Viktor" for members of the owning workspace, and email + password with
emailed codes for signup verification and password reset. Members arriving
through the Viktor access gate or a Viktor link are signed in automatically,
and a sign-in on a custom domain returns to that domain.
All of it is managed code (`SpaceSession`, the route guards, the sign-in
components): never hand-roll OAuth. Email templates are in
`convex/ViktorSpacesEmail.ts`. Public apps have no users.

### Internal Apps (Domain Restriction)

Internal apps should use `"providers": ["viktor"]`: only members of the owning
workspace can sign in and there is no signup form to restrict. When
email/password stays enabled, restrict signups to the company's email domains
(the Spaces skill says how to confirm them) in `convex/ViktorSpacesEmail.ts`:

```ts
const ALLOWED_DOMAINS = ["example.com"];

// First lines of ViktorSpacesEmail's sendVerificationRequest:
const domain = email.split("@")[1]?.toLowerCase() ?? "";
if (!ALLOWED_DOMAINS.includes(domain)) {
  throw new Error("Only company email addresses can sign up");
}
```

The check runs before the code is emailed, so other domains are rejected at
signup.

### E2E Test Login

`runTest()` signs the browser in before your test runs, with a short-lived
Viktor space session the backend mints for this project; there is no test
account or login form to drive, whatever the providers. The session is revoked
when the test ends; when the served build is public it skips sign-in and opens
`/`. If the sandbox lacks the Chromium build this project's Playwright expects,
the first run installs it.

```ts
// scripts/board-test.ts — run with: bun run test scripts/board-test.ts
import { expect } from "@playwright/test";
import { runTest } from "./auth";

runTest("Create an item", async helper => {
  const { page } = helper;
  await helper.goto("/dashboard");
  await page.getByRole("button", { name: "New item" }).click();
  await page.getByLabel("Title").fill("First item");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("First item")).toBeVisible();
  await helper.screenshot("board.png"); // tmp/board.png
}).catch(() => process.exit(1));
```

`helper` also has `context`, `browser`, `goto(path)` and
`screenshot(file, { selector, fullPage })`;
for a signed-out view, open a page in `await helper.browser.newContext()`.
`expect(...)` retries until Convex has synced, so tests need no fixed waits.
Each test file signs in separately and can run in parallel with the others. On
failure the output includes the error, a screenshot, the page text, console
logs and recent Convex logs.

Deployed preview and production URLs sit behind the platform's access gate.
`helper.goto(url)` and `createPageHelper()` pass it for this Space's own hosts
with a 10-minute token in the `x-viktor-edge-access` header. Without a browser:

```bash
bun scripts/auth.ts edge-header https://<app-url>/ | curl -sS -H @- https://<app-url>/
```

### Platform Session Users

The e2e login above and the platform's post-deploy thumbnail capture sign in as
synthetic users with emails like `space-session-<id>@viktor.invalid`. They are
automation, not people: they must never become admin/owner, claim seed data, or
trigger onboarding. Skip them in any "first signed-in user", role or seed-data
logic. The persistent marker is their `space_session` row in `authAccounts`:

```ts
import { isPlatformSessionUserId } from "./platformSession";

if (await isPlatformSessionUserId(ctx.db, ctx.userId)) return; // never the owner
```

`isPlatformSessionUser(user)` checks a user document you already have (by
email), for example in the frontend.

## Deploy Descriptor (`viktor.space.json`)

`viktor.space.json` is the platform deploy configuration; every deploy reads
it, and changes take effect on the next deploy of each environment. Local
`bun run build`/`dev` already follow `auth.mode` and `auth.providers` from this
file over `.env.local`, and the test runner signs in only when the build it
serves is authenticated. Preview-deploy before testing a newly added provider.

```json
{
  "version": 1,
  "auth": {
    "mode": "authenticated",
    "providers": ["viktor"]
  }
}
```

| `auth.mode` | Meaning |
| --- | --- |
| `"public"` | No user accounts; no sign-up/sign-in routes |
| `"authenticated"` | Convex Auth accounts using the providers declared in `auth.providers` |

`auth.providers` may be `["email_password"]`, `["viktor"]`, or both.
`email_password` lets anyone who can reach the app create an account. Omitted,
deploys use `["viktor"]`, or both when that deployment already has
email/password accounts. `auth.mode` says nothing about who can reach the URL:
the Viktor access gate in front of the app decides that, configured outside
this project. An invalid descriptor falls back to the platform default with a
warning in the deploy logs. Do not delete the file or put secrets in it.
Deploys also publish a generated `/__viktor_meta.json`; never create a file at
that path.

## Environment Variables

`.env.local` is generated; leave it as it is. The Convex deployments already
hold the auth keys, `SITE_URL` and the `VIKTOR_SPACES_*` settings; every deploy
re-syncs the access mode, providers and URLs. Optional:
`VIKTOR_SPACES_AUTH_JWT_DURATION_MS` sets the Convex Auth JWT lifetime (default 7 days, at most 30); a sign-out elsewhere reaches an
open tab only when its JWT expires.

### Adding New Variables

```bash
bunx convex env set API_KEY "value"   # also: env list, env get API_KEY, env remove API_KEY
```

```ts
const apiKey = process.env.API_KEY; // in Convex functions
```

The CLI reaches only the **dev** deployment, which preview deploys use. Set
production variables with the platform tool
`set_app_env_vars(project_name, environment="prod", values={...})` from
`sdk.tools.viktor_spaces_tools`. For AI and integrations, use the Viktor tool
gateway below, which needs no keys. If `bunx convex env …` reports WebSocket errors,
read the value from `.env.local` instead.

## Viktor Tools Integration

`convex/viktorTools.ts` calls Viktor SDK tools (AI search, structured output,
image generation, connected integrations) from Convex actions through the tool
gateway; `quickAiSearch` is the worked example. Read the Spaces skill's
`references/tool-gateway.md` before adding one. Wrappers spend the app's
project secret, so define them with `authenticatedAction`, never the raw
`action` builder.

## Live Speech-to-Text

`useRealtimeTranscription()` (`src/lib/viktor-speech/`) transcribes the signed-in
viewer's microphone live on Viktor's speech service, on desktop and mobile;
`convex/viktorSpeech.ts` mints its sessions. Use it instead of the browser's Web
Speech API. Call `start` from a click or tap and toggle with
`isActive ? stop : start`; every streamed second is billed to the workspace, so
stop as soon as input is done. While Viktor cannot be reached `state` is
`retrying`, then `unreachable`: show `error` and a "Try again" button that calls
`retry`. Only `unavailable` means the deployment has the feature off. The Spaces
skill's `references/realtime-speech.md` has the example and limits.

## HTTP Endpoints

Routes live in `convex/http.ts` at `https://<deployment>.convex.site/<path>`;
paths are exact (no wildcards).

```ts
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/webhooks/stripe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();
    try {
      await ctx.runMutation(internal.payments.handleWebhook, { event: body });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }),
});

export default http;
```

An error that escapes an `httpAction` reaches the caller as a bare 500
(production redacts the message to `Server Error`), so catch errors from
`ctx.runMutation` / `ctx.runQuery` and return `{ "error": "<message>" }` with
the status, as above. A route that stores data is also bound by "Per-Function
Limits" below: a payload that grows with the dataset goes through several
bounded mutation calls, not one.

## Convex Cheatsheet

**Queries** read data (cached, reactive). **Mutations** write data
(transactional). **Actions** run side effects (external APIs, no direct DB
access).

### Function Syntax

**Always include a `returns` validator** (`v.null()` for void functions):

```ts
import { v } from "convex/values";
import { authenticatedMutation, authenticatedQuery } from "./functions";

export const getMyProfile = authenticatedQuery({
  args: {},
  returns: v.union(v.object({ name: v.optional(v.string()) }), v.null()),
  handler: async ctx => {
    const user = await ctx.db.get(ctx.userId);
    return user ? { name: user.name } : null;
  },
});

export const renameMe = authenticatedMutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    await ctx.db.patch(ctx.userId, { name });
    return null;
  },
});
```

### Calling Functions

```ts
import { api, internal } from "./_generated/api";

// From a mutation or action:
await ctx.runQuery(internal.users.getInternal, { id });
await ctx.runMutation(internal.users.update, { id, name });

// Same-file calls need a type annotation:
const result: string = await ctx.runQuery(api.example.f, { name: "Bob" });
```

### Queries

```ts
// ❌ filter() scans the table
await ctx.db.query("users").filter(q => q.eq(q.field("email"), email));

// ✅ withIndex() (define the index in the schema first)
await ctx.db.query("users").withIndex("by_email", q => q.eq("email", email)).unique();

// ❌ No .delete() on queries; ✅ collect and delete each document
for (const user of await ctx.db.query("users").collect()) {
  await ctx.db.delete(user._id);
}
```

### Per-Function Limits

Convex enforces hard limits on every single query or mutation execution and on every document ([full list](https://docs.convex.dev/production/state/limits)). Hitting one throws with no partial success, and a function whose reads or writes grow with the dataset will hit one eventually even though it works on the first day.

| Limit (per query/mutation execution) | Value |
| --- | --- |
| `ctx.db.get` + `ctx.db.query` calls | 4,096 |
| Documents scanned | 32,000 |
| Data read / data written | 16 MiB each |
| Documents written | 16,000 |
| Function arguments / return value | 16 MiB |
| User code execution time | 1 second |

| Limit (per document, and per nested object) | Value |
| --- | --- |
| Size | 1 MiB |
| Fields | 1,024 |
| Array elements | 8,192 |

Size functions for the data the app will hold, not the sample it starts with:

- Keep one row per document; never keep a map or array keyed by an unbounded set (all users, all days) in one document.
- A batch write (import, sync, ingest route) goes through mutations of a bounded number of rows each (a few hundred at most), driven by an action or by the caller; a final small mutation switches readers over so a partially written batch is never visible.
- Loops that call `.get()` / `.unique()` per row, or `.collect()` over a whole table, are for tables whose size does not grow with usage; otherwise read an index range with `.paginate()` or `.take(n)`, and keep the totals a page needs in a summary document that the writing mutation updates.

### Schema

```ts
// convex/schema.ts — keep ...authTables
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  tasks: defineTable({
    title: v.string(),
    status: v.union(v.literal("open"), v.literal("done")),
    ownerId: v.id("users"),
  })
    .index("by_owner_and_status", ["ownerId", "status"]), // "by_" + fields
});
```

Every document has `_id` and `_creationTime`; don't define them, and don't
add `_creationTime` to an index (it is appended automatically).

### Actions

```ts
export const sendDigest = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    // ❌ ctx.db is not available in actions; ✅ read through a query
    const user = await ctx.runQuery(internal.users.get, { id: userId });
    await fetch("https://api.example.com/send", { method: "POST" });
    return null;
  },
});
```

### Types and Validators

```ts
import type { Doc, Id } from "./_generated/dataModel";
function format(user: Doc<"users">, id: Id<"users">) {}
```

`v.string()`, `v.number()`, `v.boolean()`, `v.null()`, `v.id("table")`,
`v.array(v.string())`, `v.object({ … })`, `v.optional(…)`,
`v.union(…, …)`, `v.literal("admin")`, `v.record(v.string(), v.number())`.
