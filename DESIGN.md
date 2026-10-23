# App design notes

Use the shared `frontend_design` skill for the design process. This file records
this app's decisions; the starter supplies auth, accessible interaction
primitives, and neutral tokens. Design the screens, navigation, and composition
from the product's content and workflows.

## Direction

Not designed yet. Record the audience, primary tasks, screen inventory, visual
direction, references and extracted attributes, and token decisions here.
If `/work/brand/DESIGN.md` exists, derive the app's identity from it where
appropriate and use its assets from `/work/brand/assets/`.

## Foundation

| Layer | Location |
| --- | --- |
| App surfaces | `src/pages/` — unstyled working pages (landing, dashboard, account settings) and an empty `PublicLandingPage.tsx`; design them for the app |
| Shell | `src/components/AppLayout.tsx` (signed-in screens: an unstyled bar with Settings and Sign out), `PublicHeader.tsx` (public apps: empty) |
| Routes | `src/auth/authenticated/AuthenticatedAppRoutes.tsx` or `src/auth/public/PublicAppRoutes.tsx`; README "Where things go" |
| Auth | `src/auth/SpaceSession.tsx`, route guards, sign-in/up forms, OAuth callback |
| Tokens | `src/index.css` — customize colors, typography, radius, and supported themes |
| Controls | `src/ui/` and `src/components/controlStyles.ts` — optional helpers and shared control styles |
| Interaction behavior | `@base-ui/react` — accessible, headless parts; compose and style as needed |

For additional Base UI behavior, import `@base-ui/react/<component>` and read
`https://base-ui.com/react/components/<component>.md` for its anatomy and state
attributes. Extract app-specific helpers when actual repetition warrants them.

## Review

Build with `bun run sync:build`, then run `bun run design:review` with every
route you created (README lists the defaults). Inspect the screenshots,
grayscale contact sheet, and typography specimens in `tmp/design-review/latest/`
against the direction above. Fix accessibility and overflow failures, then use
`frontend_design` for the visual critique and refinement.
