/**
 * Viktor Speech - realtime speech-to-text sessions for this app's viewers.
 *
 * `startTranscription` mints one single-use streaming session on Viktor's
 * speech service (ElevenLabs Scribe realtime, Viktor's own key) for the
 * signed-in viewer. The browser side is `useRealtimeTranscription` in
 * `src/lib/viktor-speech`; it calls this action and streams the microphone.
 * Usage is billed to the workspace as credits, like other Viktor tools.
 */
import { ConvexError, v } from "convex/values";
import { authenticatedAction } from "./functions";
import {
  transcriptionStartError,
  transcriptionUnreachable,
} from "./viktorSpeechErrors";

// Read here, not imported from viktorTools.ts: a Space's customised
// viktorTools.ts is kept as-is on a template upgrade, so speech must not
// depend on anything it exports.
declare const process: { env: Record<string, string | undefined> };

const VIKTOR_API_URL = process.env.VIKTOR_SPACES_API_URL!;
const PROJECT_NAME = process.env.VIKTOR_SPACES_PROJECT_NAME!;
const PROJECT_SECRET = process.env.VIKTOR_SPACES_PROJECT_SECRET!;
const SPACE_ID = process.env.VIKTOR_AUTH_RESOURCE_ID;

type SessionResponse = { ticket: string; ws_path: string };

const MINT_TIMEOUT_MS = 10_000;

export const startTranscription = authenticatedAction({
  args: {
    languageCode: v.optional(v.string()),
    keyterms: v.optional(v.array(v.string())),
    vadSilenceSeconds: v.optional(v.number()),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { languageCode, keyterms, vadSilenceSeconds }) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), MINT_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(
        `${VIKTOR_API_URL}/api/viktor-spaces/realtime-transcription/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: timeout.signal,
          body: JSON.stringify({
            project_name: PROJECT_NAME,
            project_secret: PROJECT_SECRET,
            space_id: SPACE_ID,
            viewer_id: ctx.userId,
            language_code: languageCode,
            keyterms,
            vad_silence_seconds: vadSilenceSeconds,
          }),
        },
      );
    } catch {
      throw new ConvexError(transcriptionUnreachable());
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        detail?: unknown;
      } | null;
      throw new ConvexError(
        transcriptionStartError(response.status, body?.detail),
      );
    }
    const session = (await response.json()) as SessionResponse;
    const wsBase = VIKTOR_API_URL.replace(/^http/, "ws").replace(/\/$/, "");
    return {
      url: `${wsBase}${session.ws_path}?ticket=${encodeURIComponent(session.ticket)}`,
    };
  },
});
