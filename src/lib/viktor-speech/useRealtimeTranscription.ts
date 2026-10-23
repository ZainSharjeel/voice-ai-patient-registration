import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import {
  createTranscriptionController,
  INITIAL_TRANSCRIPTION_VIEW,
  isOver,
  isRealtimeTranscriptionSupported,
  type TranscriptionEnd,
} from "./realtimeTranscription";

export type UseRealtimeTranscriptionOptions = {
  /** ISO 639-1/3 code such as "en" or "de"; omit to detect the language. */
  languageCode?: string;
  /** Names and jargon to recognise more reliably (up to 50). */
  keyterms?: string[];
  /** Seconds of silence that end an utterance (0.3-3, default 1). */
  vadSilenceSeconds?: number;
  /** Called with each utterance's final text, e.g. to save or act on it. */
  onFinal?: (text: string) => void;
  onEnd?: (end: TranscriptionEnd) => void;
};

/**
 * Live speech-to-text from the microphone.
 *
 * ```tsx
 * const { start, stop, isActive, transcript } = useRealtimeTranscription();
 * <button onClick={isActive ? stop : start}>{isActive ? "Stop" : "Talk"}</button>
 * <p>{transcript}</p>
 * ```
 *
 * When Viktor cannot be reached, `state` is `retrying` (with `error` saying
 * so) while the request is retried, then `unreachable`; show a "Try again"
 * button that calls `retry` in both. `unavailable` means this Viktor
 * deployment has live transcription turned off.
 *
 * `transcript` is every final utterance plus the partial still being spoken;
 * `finals` and `partial` are there to render them differently. Only signed-in
 * viewers can start a session (`viktorSpeech.startTranscription` is an
 * authenticated action); usage is billed to the workspace as credits.
 */
export function useRealtimeTranscription(
  options: UseRealtimeTranscriptionOptions = {},
) {
  const startTranscription = useAction(api.viktorSpeech.startTranscription);
  const latest = useRef({ options, startTranscription });
  latest.current = { options, startTranscription };
  const [view, setView] = useState(INITIAL_TRANSCRIPTION_VIEW);
  const [controller] = useState(() =>
    createTranscriptionController(() => {
      const { languageCode, keyterms, vadSilenceSeconds } =
        latest.current.options;
      return {
        getSession: () =>
          latest.current.startTranscription({
            languageCode,
            keyterms,
            vadSilenceSeconds,
          }),
        onFinal: text => latest.current.options.onFinal?.(text),
        onEnd: end => latest.current.options.onEnd?.(end),
      };
    }, setView),
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const finalText = useMemo(() => view.finals.join(" "), [view.finals]);

  return {
    ...view,
    isListening: view.state === "listening",
    isActive: view.state !== "idle" && !isOver(view.state),
    isSupported: isRealtimeTranscriptionSupported(),
    transcript: [finalText, view.partial].filter(Boolean).join(" "),
    start: controller.start,
    stop: controller.stop,
    retry: controller.retry,
    commit: controller.commit,
    reset: controller.reset,
  };
}
